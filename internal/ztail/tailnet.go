package ztail

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

type TailStatus struct {
	State     string   `json:"state"`
	AuthURL   string   `json:"authUrl"`
	Tailnet   string   `json:"tailnet"`
	DNSSuffix string   `json:"dnsSuffix"`
	Hostname  string   `json:"hostname"`
	NodeID    string   `json:"nodeId"`
	Tags      []string `json:"tags"`
	IPs       []string `json:"ips"`
	MagicDNS  bool     `json:"magicDns"`
	HTTPS     bool     `json:"https"`
	Error     string   `json:"error"`
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
	Withdraw(context.Context, string) error
	Advertisements(context.Context) ([]string, error)
	Close() error
}
type EmbeddedTailnet struct {
	mu          sync.Mutex
	cfg         Config
	server      *tsnet.Server
	watchCancel context.CancelFunc
	lastError   string
}

func NewTailnet(c Config) *EmbeddedTailnet { return &EmbeddedTailnet{cfg: c} }
func (t *EmbeddedTailnet) startLocked() error {
	if t.server != nil {
		return nil
	}
	s := &tsnet.Server{Dir: filepath.Join(t.cfg.DataDir, "tailscale"), Hostname: "ztail", AdvertiseTags: []string{t.cfg.NodeTag()}, Ephemeral: false, UserLogf: func(string, ...any) {}}
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
	if lc, e := s.LocalClient(); e == nil {
		if watcher, e := lc.WatchIPNBus(watchCtx, ipn.NotifyInitialState); e == nil {
			go func() {
				defer watcher.Close()
				for {
					notification, e := watcher.Next()
					if e != nil {
						return
					}
					t.mu.Lock()
					if notification.ErrMessage != nil && *notification.ErrMessage != "" {
						t.lastError = "Tailscale 接入失败，请检查 Auth Key、tag 权限或网络后重试"
					}
					if notification.State != nil && *notification.State == ipn.Running {
						t.lastError = ""
					}
					t.mu.Unlock()
				}
			}()
		}
	}
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
	prefs := &ipn.Prefs{WantRunning: true, Hostname: "ztail", AdvertiseTags: []string{t.cfg.NodeTag()}, CorpDNS: false}
	if err = lc.Start(ctx, ipn.Options{AuthKey: key, UpdatePrefs: prefs}); err != nil {
		return errors.New("接入失败，请检查 Auth Key 的有效期和 tag 权限")
	}
	if method == "interactive" {
		if err = lc.StartLoginInteractive(ctx); err != nil {
			return errors.New("无法启动交互式授权，请重试")
		}
	}
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
