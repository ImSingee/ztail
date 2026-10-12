package ztail

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"
)

type RuleStatus struct {
	ID              string `json:"id"`
	State           string `json:"state"`
	Error           string `json:"error"`
	URL             string `json:"url"`
	AppliedRevision int64  `json:"appliedRevision"`
	Backend         string `json:"backend"`
	Approval        string `json:"approval"`
	ActiveURL       string `json:"activeUrl"`
	ActiveTarget    string `json:"activeTarget"`
}
type RuleView struct {
	Rule
	Status RuleStatus `json:"status"`
	Target string     `json:"target"`
}
type withdrawal struct {
	RuleID string `json:"ruleId"`
	Error  string `json:"error"`
}
type Manager struct {
	mu          sync.Mutex
	reconcileMu sync.Mutex
	cfg         Config
	store       *Store
	catalog     CatalogProvider
	tail        Tailnet
	registry    Registry
	running     map[string]*runtimeRule
	states      map[string]RuleStatus
	pending     map[string]withdrawal
	wake        chan struct{}
	done        chan struct{}
	cancel      context.CancelFunc
}

func NewManager(c Config, s *Store, z CatalogProvider, t Tailnet, r Registry) *Manager {
	return &Manager{cfg: c, store: s, catalog: z, tail: t, registry: r, running: map[string]*runtimeRule{}, states: map[string]RuleStatus{}, pending: map[string]withdrawal{}, wake: make(chan struct{}, 1), done: make(chan struct{})}
}
func (m *Manager) Start(ctx context.Context) {
	ctx, m.cancel = context.WithCancel(ctx)
	go func() {
		defer close(m.done)
		tick := time.NewTicker(10 * time.Second)
		defer tick.Stop()
		m.Reconcile(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-m.wake:
				m.Reconcile(ctx)
			case <-tick.C:
				m.Reconcile(ctx)
			}
		}
	}()
}
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
func (m *Manager) Close() {
	if m.cancel != nil {
		m.cancel()
		<-m.done
	}
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()
	for id, rt := range m.running {
		_ = m.queueWithdrawal(rt.rule.Name, id)
		_ = rt.Close()
		delete(m.running, id)
	}
	ctx, cancel := tailContext()
	defer cancel()
	m.flushWithdrawals(ctx)
}
func (m *Manager) Views() ([]RuleView, error) {
	rules, err := m.store.List()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []RuleView{}
	for _, r := range rules {
		st, ok := m.states[r.ID]
		if !ok {
			st = RuleStatus{ID: r.ID, State: "draft", Approval: "unknown", Backend: "unknown"}
		}
		out = append(out, RuleView{Rule: r, Status: st, Target: r.Target(m.cfg.ClusterDomain).String()})
	}
	return out, nil
}
func (m *Manager) setState(id string, st RuleStatus) { m.mu.Lock(); m.states[id] = st; m.mu.Unlock() }
func (m *Manager) WithdrawalErrors() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []string{}
	for name, p := range m.pending {
		out = append(out, "svc:"+name+": "+p.Error)
	}
	return out
}
func (m *Manager) saveWithdrawalsLocked() error {
	body, err := json.Marshal(m.pending)
	if err != nil {
		return err
	}
	return m.store.SetSetting("withdrawals", string(body))
}
func (m *Manager) queueWithdrawal(name, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pending[name] = withdrawal{RuleID: id, Error: "撤回尚未完成，将自动重试"}
	return m.saveWithdrawalsLocked()
}
func (m *Manager) loadWithdrawals() error {
	body, err := m.store.Setting("withdrawals")
	if err != nil {
		return err
	}
	if body == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return json.Unmarshal([]byte(body), &m.pending)
}
func (m *Manager) flushWithdrawals(ctx context.Context) {
	m.mu.Lock()
	copy := map[string]withdrawal{}
	for k, v := range m.pending {
		copy[k] = v
	}
	m.mu.Unlock()
	for name, p := range copy {
		err := m.tail.Withdraw(ctx, name)
		m.mu.Lock()
		if err == nil {
			delete(m.pending, name)
		} else {
			p.Error = m.cfg.Redact(err.Error())
			m.pending[name] = p
		}
		if e := m.saveWithdrawalsLocked(); e != nil {
			p.Error = "无法保存撤回状态，将自动重试"
			m.pending[name] = p
		}
		m.mu.Unlock()
	}
}
func (m *Manager) Reconcile(parent context.Context) {
	m.reconcileMu.Lock()
	defer m.reconcileMu.Unlock()
	rules, err := m.store.List()
	if err != nil {
		return
	}
	if err = m.loadWithdrawals(); err != nil {
		for _, r := range rules {
			m.setState(r.ID, RuleStatus{ID: r.ID, State: "error", Error: "无法读取撤回记录，请检查数据卷"})
		}
		return
	}
	desired := map[string]Rule{}
	for _, r := range rules {
		desired[r.ID] = r
	}
	for id, rt := range m.running {
		r, ok := desired[id]
		if !ok || !r.Enabled {
			if err = m.queueWithdrawal(rt.rule.Name, id); err != nil {
				m.setState(id, RuleStatus{ID: id, State: "error", Error: "无法记录撤回操作，请检查数据卷"})
				continue
			}
			_ = rt.Close()
			delete(m.running, id)
		}
		if !ok {
			m.mu.Lock()
			delete(m.states, id)
			m.mu.Unlock()
		}
	}
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	ts := m.tail.Status(ctx)
	cancel()
	if ts.State == "Running" {
		ctx, cancel := context.WithTimeout(parent, 15*time.Second)
		// Recover orphaned advertisements when a process died between saving a
		// disable/delete operation and applying it. Only this embedded node is owned.
		ads, e := m.tail.Advertisements(ctx)
		if e != nil {
			cancel()
			for _, r := range rules {
				m.setState(r.ID, RuleStatus{ID: r.ID, State: "error", Error: "无法核对节点广告，暂停应用配置"})
			}
			return
		}
		for _, name := range ads {
			owned := false
			for _, rt := range m.running {
				if rt.rule.Name == name {
					owned = true
					break
				}
			}
			if !owned {
				if e = m.queueWithdrawal(name, ""); e != nil {
					cancel()
					return
				}
			}
		}
		m.flushWithdrawals(ctx)
		cancel()
	}
	for _, r := range rules {
		if parent.Err() != nil {
			return
		}
		m.reconcileRule(parent, r, ts)
	}
}
func (m *Manager) reconcileRule(parent context.Context, r Rule, ts TailStatus) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	st := RuleStatus{ID: r.ID, State: "draft", Backend: "unknown", Approval: "unknown"}
	if ts.DNSSuffix != "" {
		st.URL = "https://" + r.Name + "." + ts.DNSSuffix
	}
	rt := m.running[r.ID]
	fail := func(err error) {
		st.State = "error"
		st.Error = m.cfg.Redact(err.Error())
		if rt != nil {
			st.AppliedRevision = rt.rule.Revision
			st.State = "update_failed"
			st.ActiveURL = "https://" + rt.rule.Name + "." + ts.DNSSuffix
			st.ActiveTarget = rt.target.String()
		}
		m.setState(r.ID, st)
	}
	m.mu.Lock()
	pending := false
	for name, p := range m.pending {
		if p.RuleID == r.ID || name == r.Name {
			pending = true
			st.Error = p.Error
			break
		}
	}
	m.mu.Unlock()
	if pending {
		st.State = "withdrawal_pending"
		if rt != nil {
			st.AppliedRevision = rt.rule.Revision
		}
		m.setState(r.ID, st)
		return
	}
	if !r.Enabled {
		if rt != nil {
			fail(errors.New("撤回未完成，请检查数据卷后重试"))
		} else {
			m.setState(r.ID, st)
		}
		return
	}
	if ts.State != "Running" {
		fail(errors.New("Tailscale 尚未连接，请完成节点授权"))
		return
	}
	if !slices.Contains(ts.Tags, m.cfg.NodeTag()) {
		fail(fmt.Errorf("节点尚未获得 %s，请检查 tagOwners 与节点 tag", m.cfg.NodeTag()))
		return
	}
	bound, err := m.store.Setting("tailnet")
	if err != nil {
		fail(err)
		return
	}
	if bound != "" && bound != ts.Tailnet {
		if rt != nil {
			if err = m.queueWithdrawal(rt.rule.Name, r.ID); err != nil {
				fail(err)
				return
			}
			_ = rt.Close()
			delete(m.running, r.ID)
			rt = nil
		}
		fail(errors.New("当前 tailnet 与已保存规则不一致，已停止发布；请恢复原 tailnet"))
		return
	}
	if bound == "" {
		if err = m.store.SetSetting("tailnet", ts.Tailnet); err != nil {
			fail(err)
			return
		}
	}
	if rt != nil && rt.rule.Revision == r.Revision {
		st.State = "advertised"
		st.AppliedRevision = r.Revision
		st.Backend = m.probe(ctx, r)
		m.setState(r.ID, st)
		return
	}
	if !ts.MagicDNS || !ts.HTTPS {
		fail(errors.New("请在 Tailscale 控制台开启 MagicDNS 和 HTTPS 证书"))
		return
	}
	if r.Source == "zeabur" && !m.catalog.Contains(r) {
		fail(errors.New("目录中找不到所选项目、环境或服务，请刷新 Zeabur 目录"))
		return
	}
	if m.cfg.TailscaleKey != "" {
		if err = m.registry.Ensure(ctx, ts.Tailnet, r.Name, r.CreateService); err != nil {
			fail(err)
			return
		}
	} else {
		if r.CreateService {
			fail(errors.New("创建 Service 需要配置 TAILSCALE_API_KEY"))
			return
		}
		defs, e := m.tail.Services(ctx)
		if e != nil {
			fail(e)
			return
		}
		def, ok := defs["svc:"+r.Name]
		if !ok {
			fail(errors.New("Service 未定义或对本节点不可见，请在控制台定义 svc:" + r.Name + "，并配置访问策略"))
			return
		}
		if e = compatiblePorts(def.Ports); e != nil {
			fail(e)
			return
		}
	}
	if rt != nil && rt.rule.Name == r.Name {
		rt.swap(r, r.Target(m.cfg.ClusterDomain))
		st.State = "advertised"
		st.AppliedRevision = r.Revision
		st.Backend = m.probe(ctx, r)
		m.setState(r.ID, st)
		return
	}
	ln, e := m.tail.Listen(ctx, r.Name)
	if e != nil {
		fail(errors.New("Service 广告失败: " + e.Error()))
		return
	}
	next := startRuntime(r, ln, r.Target(m.cfg.ClusterDomain))
	if rt != nil {
		if err = m.queueWithdrawal(rt.rule.Name, r.ID); err != nil {
			_ = next.Close()
			fail(err)
			return
		}
		_ = rt.Close()
	}
	m.running[r.ID] = next
	if rt != nil {
		m.flushWithdrawals(ctx)
	}
	st.State = "advertised"
	st.AppliedRevision = r.Revision
	st.Backend = m.probe(ctx, r)
	m.setState(r.ID, st)
}
func (m *Manager) probe(ctx context.Context, r Rule) string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "HEAD", r.Target(m.cfg.ClusterDomain).String(), nil)
	if err != nil {
		return "unreachable"
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil, TLSHandshakeTimeout: 2 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return "unreachable"
	}
	resp.Body.Close()
	return "reachable"
}
