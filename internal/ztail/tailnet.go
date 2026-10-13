package ztail

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type TailStatus struct {
	ErrorInfo     *MessageInfo `json:"errorInfo,omitempty"`
	State         string       `json:"state"`
	AuthURL       string       `json:"authUrl"`
	Tailnet       string       `json:"tailnet"`
	DNSSuffix     string       `json:"dnsSuffix"`
	Hostname      string       `json:"hostname"`
	DNSName       string       `json:"dnsName"`
	PanelURL      string       `json:"panelUrl"`
	PanelError    string       `json:"panelError"`
	NodeID        string       `json:"nodeId"`
	Tags          []string     `json:"tags"`
	IPs           []string     `json:"ips"`
	MagicDNS      bool         `json:"magicDns"`
	HTTPS         bool         `json:"https"`
	Error         string       `json:"error"`
	Connecting    bool         `json:"connecting"`
	ConnectMethod string       `json:"connectMethod"`
	Health        []string     `json:"health"`
}
type ServiceDefinition struct {
	Name  string   `json:"name"`
	Ports []string `json:"ports"`
	Tags  []string `json:"tags"`
}
type Tailnet interface {
	Status(context.Context) TailStatus
	Connect(context.Context, string, string) error
	Services(context.Context) (map[string]ServiceDefinition, error)
	Listen(context.Context, Rule) (net.Listener, error)
	ListenPanel(context.Context) (net.Listener, error)
	Withdraw(context.Context, string) error
	Advertisements(context.Context) ([]string, error)
	Close() error
}
type EmbeddedTailnet struct {
	mu             sync.Mutex
	cfg            Config
	server         *tsnet.Server
	watchCancel    context.CancelFunc
	lastError      string
	connectStarted time.Time
	connectMethod  string
	lastState      string
	lastHealth     string
}

var tailscaleSecret = regexp.MustCompile(`tskey-[A-Za-z0-9_-]+`)

func (t *EmbeddedTailnet) redact(message string) string {
	return tailscaleSecret.ReplaceAllString(t.cfg.Redact(message), "[redacted]")
}
func (t *EmbeddedTailnet) logf(format string, args ...any) {
	log.Printf("[tailscale] %s", t.redact(fmt.Sprintf(format, args...)))
}

func NewTailnet(c Config) *EmbeddedTailnet { return &EmbeddedTailnet{cfg: c} }
func (t *EmbeddedTailnet) startLocked() error {
	if t.server != nil {
		return nil
	}
	s := &tsnet.Server{Dir: filepath.Join(t.cfg.DataDir, "tailscale"), Hostname: "ztail", AdvertiseTags: []string{t.cfg.NodeTag()}, Ephemeral: false, UserLogf: func(format string, args ...any) { t.logf(format, args...) }}
	return t.startServerLocked(s)
}

// startServerLocked owns server startup and asynchronous state observation.
func (t *EmbeddedTailnet) startServerLocked(s *tsnet.Server) error {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return err
	}
	if err := s.Start(); err != nil {
		s.Close()
		return err
	}
	t.server = s
	watchCtx, cancel := context.WithCancel(context.Background())
	t.watchCancel = cancel
	lc, err := s.LocalClient()
	if err != nil {
		cancel()
		s.Close()
		t.server = nil
		return err
	}
	watcher, err := lc.WatchIPNBus(watchCtx, ipn.NotifyInitialState)
	if err != nil {
		cancel()
		s.Close()
		t.server = nil
		return err
	}
	go func() {
		defer watcher.Close()
		for {
			notification, e := watcher.Next()
			if e != nil {
				if watchCtx.Err() == nil {
					t.mu.Lock()
					t.lastError = "Tailscale status watch interrupted. Restart ztail"
					t.connectStarted = time.Time{}
					t.logf("%s", t.lastError)
					t.mu.Unlock()
				}
				return
			}
			t.mu.Lock()
			if notification.ErrMessage != nil && *notification.ErrMessage != "" {
				message := t.redact(*notification.ErrMessage)
				if t.lastError != message {
					t.logf("Enrollment failed: %s", message)
				}
				t.lastError = message
				t.connectStarted = time.Time{}
			}
			if notification.State != nil {
				state := notification.State.String()
				if state != t.lastState {
					t.logf("Node status: %s", state)
					t.lastState = state
				}
				if *notification.State == ipn.Running || *notification.State == ipn.NeedsMachineAuth {
					t.lastError = ""
					t.connectStarted = time.Time{}
				}
			}
			t.mu.Unlock()
		}
	}()
	return nil
}
func (t *EmbeddedTailnet) Status(ctx context.Context) TailStatus {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		if _, err := os.Stat(filepath.Join(t.cfg.DataDir, "tailscale", "tailscaled.state")); err != nil {
			return TailStatus{State: "NeedsLogin", Tags: []string{}, IPs: []string{}}
		}
		if err := t.startLocked(); err != nil {
			return TailStatus{State: "Error", Error: "Tailscale could not start"}
		}
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return TailStatus{State: "Error", Error: "Tailscale local API unavailable"}
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return TailStatus{State: "Error", Error: "Could not read Tailscale status"}
	}
	out := TailStatus{State: st.BackendState, AuthURL: st.AuthURL, Tags: []string{}, IPs: []string{}}
	if st.Self != nil {
		out.Hostname = st.Self.HostName
		out.DNSName = strings.TrimSuffix(st.Self.DNSName, ".")
		out.NodeID = string(st.Self.ID)
		if st.Self.Tags != nil {
			for _, tag := range st.Self.Tags.All() {
				out.Tags = append(out.Tags, tag)
			}
		}
	}
	for _, ip := range st.TailscaleIPs {
		out.IPs = append(out.IPs, ip.String())
	}
	if st.CurrentTailnet != nil {
		out.Tailnet = st.CurrentTailnet.Name
		out.DNSSuffix = st.CurrentTailnet.MagicDNSSuffix
		out.MagicDNS = st.CurrentTailnet.MagicDNSEnabled
	}
	out.HTTPS = len(st.CertDomains) > 0
	// Start is asynchronous: expose progress until the control plane responds.
	if st.BackendState == "Running" || st.BackendState == "NeedsMachineAuth" {
		t.connectStarted = time.Time{}
		t.lastError = ""
	}
	if !t.connectStarted.IsZero() && time.Since(t.connectStarted) >= 90*time.Second {
		t.connectStarted = time.Time{}
		t.lastError = "Tailscale enrollment has taken over 90 seconds. Check the network, Auth Key and tag permissions, then retry. Connection attempts will continue in the background"
		t.logf("%s", t.lastError)
	}
	out.Connecting = !t.connectStarted.IsZero()
	out.ConnectMethod = t.connectMethod
	for _, warning := range st.Health {
		out.Health = append(out.Health, t.redact(warning))
	}
	slices.Sort(out.Health)
	health := strings.Join(out.Health, "; ")
	if health != t.lastHealth {
		if health != "" {
			t.logf("Health warning: %s", health)
		}
		t.lastHealth = health
	}
	out.Error = t.lastError
	return out
}
func (t *EmbeddedTailnet) Connect(ctx context.Context, method, key string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if method != "interactive" && method != "authkey" {
		return messageError("Choose interactive authorization or an Auth Key")
	}
	if method == "authkey" && key == "" {
		return messageError("Enter an Auth Key")
	}
	if method == "authkey" && !strings.HasPrefix(key, "tskey-auth-") {
		return messageError("Enter a Tailscale Auth Key (starting with tskey-auth-), not an API Key or OAuth credential")
	}
	if err := t.startLocked(); err != nil {
		return messageError("Tailscale could not start")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return messageError("Tailscale local API unavailable")
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return messageError("Could not read Tailscale status")
	}
	if st.BackendState == "Running" {
		return messageError("Node already connected. Manage authorization in the Tailscale console")
	}
	if st.BackendState == "NeedsMachineAuth" {
		return messageError("Node awaiting admin approval. Approve it in the Tailscale console")
	}
	t.lastError = ""
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return messageError("Could not read Tailscale enrollment configuration")
	}
	prefs.WantRunning = true
	prefs.LoggedOut = false
	prefs.Hostname = "ztail"
	prefs.AdvertiseTags = []string{t.cfg.NodeTag()}
	prefs.CorpDNS = false
	if err = lc.Start(ctx, ipn.Options{AuthKey: key, UpdatePrefs: prefs}); err != nil {
		return messageError("Enrollment failed. Check Auth Key expiration and tag permissions")
	}
	// Start installs the AuthKey on a new control client, but does not log a
	// fresh node in. Trigger login for BOTH methods, as tsnet.Start itself does.
	// With a valid AuthKey the control plane registers the node without a browser.
	if err = lc.StartLoginInteractive(ctx); err != nil {
		return messageError("Could not start Tailscale sign-in. Retry")
	}
	t.connectStarted = time.Now()
	t.connectMethod = method
	t.logf("Starting enrollment: method=%s tag=%s", method, t.cfg.NodeTag())
	return nil
}
func (t *EmbeddedTailnet) Services(ctx context.Context) (map[string]ServiceDefinition, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return nil, messageError("Join the tailnet first")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return nil, err
	}
	services, err := lc.GetServices(ctx)
	if err != nil {
		return nil, messageError("Could not read visible Services. Check the tailnet access policy")
	}
	out := map[string]ServiceDefinition{}
	for name, s := range services {
		def := ServiceDefinition{Name: string(name), Ports: []string{}}
		for _, p := range s.Ports {
			def.Ports = append(def.Ports, p.String())
		}
		out[string(name)] = def
	}
	return out, nil
}
func (t *EmbeddedTailnet) Listen(ctx context.Context, rule Rule) (net.Listener, error) {
	if err := rule.Validate(); err != nil {
		return nil, err
	}
	st := t.Status(ctx)
	if st.State != "Running" {
		return nil, messageError("Complete Tailscale authorization first")
	}
	if !slices.Contains(st.Tags, t.cfg.NodeTag()) {
		return nil, messageError("Node requires {0}. Check tagOwners and the node tag", t.cfg.NodeTag())
	}
	// Up in ListenService has no context parameter: invoke it only after checking
	// Running, and serialize it with Connect/Close through the owner mutex.
	t.mu.Lock()
	defer t.mu.Unlock()
	if rule.Protocol == "tcp" {
		return t.server.ListenService("svc:"+rule.Name, tsnet.ServiceModeTCP{Port: uint16(rule.PublicPort())})
	}
	return t.server.ListenService("svc:"+rule.Name, tsnet.ServiceModeHTTP{HTTPS: true, Port: 443})
}

// ListenPanel binds the node's own HTTPS port, independently of Service VIPs.
func (t *EmbeddedTailnet) ListenPanel(ctx context.Context) (net.Listener, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return nil, messageError("Complete Tailscale authorization first")
	}
	// ListenTLS uses a background context while waiting for Up. Use the same
	// TLS construction with cancellable Up so shutdown cannot stall on login.
	st, err := t.server.Up(ctx)
	if err != nil {
		return nil, err
	}
	if st.CurrentTailnet == nil || !st.CurrentTailnet.MagicDNSEnabled || len(st.CertDomains) == 0 {
		return nil, messageError("Enable MagicDNS and HTTPS in the Tailscale console")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return nil, err
	}
	ln, err := t.server.Listen("tcp", ":443")
	if err != nil {
		return nil, err
	}
	return tls.NewListener(ln, &tls.Config{GetCertificate: lc.GetCertificate}), nil
}
func (t *EmbeddedTailnet) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.watchCancel != nil {
		t.watchCancel()
	}
	if t.server != nil {
		return t.server.Close()
	}
	return nil
}
func tailContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 8*time.Second)
}

// Withdraw is idempotent and also recovers a failed listener cleanup after
// restart. It never changes another node's advertisement or service definition.
func (t *EmbeddedTailnet) Withdraw(ctx context.Context, name string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return messageError("Node disconnected; withdrawal will retry after connecting")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return err
	}
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return messageError("Could not read node advertisement configuration")
	}
	next := []string{}
	for _, svc := range prefs.AdvertiseServices {
		if svc != "svc:"+name {
			next = append(next, svc)
		}
	}
	if _, err = lc.EditPrefs(ctx, &ipn.MaskedPrefs{AdvertiseServicesSet: true, Prefs: ipn.Prefs{AdvertiseServices: next}}); err != nil {
		return messageError("Service advertisement withdrawal failed; retrying automatically")
	}
	sc, err := lc.GetServeConfig(ctx)
	if err != nil {
		return messageError("Could not read Service listener configuration")
	}
	if sc == nil {
		return nil
	}
	for service := range sc.Services {
		if string(service) == "svc:"+name {
			delete(sc.Services, service)
		}
	}
	if err = lc.SetServeConfig(ctx, sc); err != nil {
		return messageError("Service listener cleanup failed; retrying automatically")
	}
	return nil
}
func (t *EmbeddedTailnet) Advertisements(ctx context.Context) ([]string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return nil, nil
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return nil, err
	}
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, name := range prefs.AdvertiseServices {
		if bare, ok := strings.CutPrefix(name, "svc:"); ok {
			out = append(out, bare)
		}
	}
	return out, nil
}

func (value TailStatus) MarshalJSON() ([]byte, error) {
	type plain TailStatus
	if value.ErrorInfo == nil {
		value.ErrorInfo = displayTextMessage(value.Error)
	}
	return json.Marshal(plain(value))
}
