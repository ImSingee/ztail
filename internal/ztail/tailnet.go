package ztail

import (
	"context"
	"crypto/tls"
	"errors"
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
	State         string   `json:"state"`
	AuthURL       string   `json:"authUrl"`
	Tailnet       string   `json:"tailnet"`
	DNSSuffix     string   `json:"dnsSuffix"`
	Hostname      string   `json:"hostname"`
	DNSName       string   `json:"dnsName"`
	PanelURL      string   `json:"panelUrl"`
	PanelError    string   `json:"panelError"`
	NodeID        string   `json:"nodeId"`
	Tags          []string `json:"tags"`
	IPs           []string `json:"ips"`
	MagicDNS      bool     `json:"magicDns"`
	HTTPS         bool     `json:"https"`
	Error         string   `json:"error"`
	Connecting    bool     `json:"connecting"`
	ConnectMethod string   `json:"connectMethod"`
	Health        []string `json:"health"`
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
	Listen(context.Context, string) (net.Listener, error)
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
					t.lastError = "Tailscale 状态监听中断，请重启 ztail"
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
					t.logf("接入失败: %s", message)
				}
				t.lastError = message
				t.connectStarted = time.Time{}
			}
			if notification.State != nil {
				state := notification.State.String()
				if state != t.lastState {
					t.logf("节点状态: %s", state)
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
			return TailStatus{State: "Error", Error: "Tailscale 无法启动"}
		}
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return TailStatus{State: "Error", Error: "Tailscale 本地接口不可用"}
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return TailStatus{State: "Error", Error: "无法读取 Tailscale 状态"}
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
		t.lastError = "Tailscale 接入尚未完成（等待超过 90 秒），请检查网络、Auth Key 和 tag 权限后重试；后台会继续尝试连接"
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
			t.logf("健康警告: %s", health)
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
		return errors.New("请选择 interactive 或 Auth Key")
	}
	if method == "authkey" && key == "" {
		return errors.New("请输入 Auth Key")
	}
	if method == "authkey" && !strings.HasPrefix(key, "tskey-auth-") {
		return errors.New("请输入 Tailscale Auth Key（tskey-auth- 开头），不是 API Key 或 OAuth 凭据")
	}
	if err := t.startLocked(); err != nil {
		return errors.New("Tailscale 无法启动")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return errors.New("Tailscale 本地接口不可用")
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return errors.New("无法读取 Tailscale 状态")
	}
	if st.BackendState == "Running" {
		return errors.New("节点已连接；请在 Tailscale 控制台管理节点授权")
	}
	if st.BackendState == "NeedsMachineAuth" {
		return errors.New("节点正在等待管理员审批，请到 Tailscale 控制台批准节点")
	}
	t.lastError = ""
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return errors.New("无法读取 Tailscale 接入配置")
	}
	prefs.WantRunning = true
	prefs.LoggedOut = false
	prefs.Hostname = "ztail"
	prefs.AdvertiseTags = []string{t.cfg.NodeTag()}
	prefs.CorpDNS = false
	if err = lc.Start(ctx, ipn.Options{AuthKey: key, UpdatePrefs: prefs}); err != nil {
		return errors.New("接入失败，请检查 Auth Key 的有效期和 tag 权限")
	}
	// Start installs the AuthKey on a new control client, but does not log a
	// fresh node in. Trigger login for BOTH methods, as tsnet.Start itself does.
	// With a valid AuthKey the control plane registers the node without a browser.
	if err = lc.StartLoginInteractive(ctx); err != nil {
		return errors.New("无法启动 Tailscale 登录，请重试")
	}
	t.connectStarted = time.Now()
	t.connectMethod = method
	t.logf("开始节点接入: method=%s tag=%s", method, t.cfg.NodeTag())
	return nil
}
func (t *EmbeddedTailnet) Services(ctx context.Context) (map[string]ServiceDefinition, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return nil, errors.New("请先加入 tailnet")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return nil, err
	}
	services, err := lc.GetServices(ctx)
	if err != nil {
		return nil, errors.New("无法读取可见 Service，请检查 tailnet 访问策略")
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
func (t *EmbeddedTailnet) Listen(ctx context.Context, name string) (net.Listener, error) {
	st := t.Status(ctx)
	if st.State != "Running" {
		return nil, errors.New("请先完成 Tailscale 授权")
	}
	if !slices.Contains(st.Tags, t.cfg.NodeTag()) {
		return nil, fmt.Errorf("节点需要 %s，请检查 tagOwners 和节点 tag", t.cfg.NodeTag())
	}
	// Up in ListenService has no context parameter: invoke it only after checking
	// Running, and serialize it with Connect/Close through the owner mutex.
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.server.ListenService("svc:"+name, tsnet.ServiceModeHTTP{HTTPS: true, Port: 443})
}

// ListenPanel binds the node's own HTTPS port, independently of Service VIPs.
func (t *EmbeddedTailnet) ListenPanel(ctx context.Context) (net.Listener, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.server == nil {
		return nil, errors.New("请先完成 Tailscale 授权")
	}
	// ListenTLS uses a background context while waiting for Up. Use the same
	// TLS construction with cancellable Up so shutdown cannot stall on login.
	st, err := t.server.Up(ctx)
	if err != nil {
		return nil, err
	}
	if st.CurrentTailnet == nil || !st.CurrentTailnet.MagicDNSEnabled || len(st.CertDomains) == 0 {
		return nil, errors.New("请在 Tailscale 控制台开启 MagicDNS 和 HTTPS")
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
		return errors.New("节点尚未连接，撤回将在连接后重试")
	}
	lc, err := t.server.LocalClient()
	if err != nil {
		return err
	}
	prefs, err := lc.GetPrefs(ctx)
	if err != nil {
		return errors.New("无法读取节点广告配置")
	}
	next := []string{}
	for _, svc := range prefs.AdvertiseServices {
		if svc != "svc:"+name {
			next = append(next, svc)
		}
	}
	if _, err = lc.EditPrefs(ctx, &ipn.MaskedPrefs{AdvertiseServicesSet: true, Prefs: ipn.Prefs{AdvertiseServices: next}}); err != nil {
		return errors.New("撤回 Service 广告失败，将自动重试")
	}
	sc, err := lc.GetServeConfig(ctx)
	if err != nil {
		return errors.New("无法读取 Service 监听配置")
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
		return errors.New("清理 Service 监听配置失败，将自动重试")
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
