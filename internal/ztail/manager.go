package ztail

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"
)

type RuleStatus struct {
	ErrorInfo       *MessageInfo `json:"errorInfo,omitempty"`
	ID              string       `json:"id"`
	State           string       `json:"state"`
	Error           string       `json:"error"`
	URL             string       `json:"url"`
	AppliedRevision int64        `json:"appliedRevision"`
	Backend         string       `json:"backend"`
	Approval        string       `json:"approval"`
	ActiveURL       string       `json:"activeUrl"`
	ActiveTarget    string       `json:"activeTarget"`
}
type RuleView struct {
	Rule
	Status RuleStatus `json:"status"`
	Target string     `json:"target"`
}
type withdrawal struct {
	ErrorInfo *MessageInfo `json:"errorInfo,omitempty"`
	RuleID    string       `json:"ruleId"`
	Error     string       `json:"error"`
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
	m.pending[name] = withdrawal{RuleID: id, Error: "Withdrawal not complete; retrying automatically"}
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
			p.ErrorInfo = redactMessage(displayErrorMessage(err), m.cfg.Redact)
			m.pending[name] = p
		}
		if e := m.saveWithdrawalsLocked(); e != nil {
			p.Error = "Could not save withdrawal state; retrying automatically"
			p.ErrorInfo = textMessage(p.Error)
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
			m.setState(r.ID, RuleStatus{ID: r.ID, State: "error", Error: "Could not read withdrawal records. Check the data volume"})
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
				m.setState(id, RuleStatus{ID: id, State: "error", Error: "Could not record withdrawal. Check the data volume"})
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
				m.setState(r.ID, RuleStatus{ID: r.ID, State: "error", Error: "Could not verify node advertisements; configuration apply paused"})
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
	st.URL = r.AccessURL(ts.DNSSuffix)
	rt := m.running[r.ID]
	fail := func(err error) {
		st.State = "error"
		st.Error = m.cfg.Redact(err.Error())
		st.ErrorInfo = redactMessage(displayErrorMessage(err), m.cfg.Redact)
		if rt != nil {
			st.AppliedRevision = rt.rule.Revision
			st.State = "update_failed"
			st.ActiveURL = rt.rule.AccessURL(ts.DNSSuffix)
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
			st.ErrorInfo = p.ErrorInfo
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
			fail(messageError("Withdrawal not complete. Check the data volume and retry"))
		} else {
			m.setState(r.ID, st)
		}
		return
	}
	if ts.State != "Running" {
		fail(messageError("Tailscale disconnected. Complete node authorization"))
		return
	}
	if !slices.Contains(ts.Tags, m.cfg.NodeTag()) {
		fail(messageError("Node has not received {0}. Check tagOwners and the node tag", m.cfg.NodeTag()))
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
		fail(messageError("Current tailnet differs from saved rules. Publishing stopped; restore the original tailnet"))
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
	if !ts.MagicDNS {
		fail(messageError("Enable MagicDNS in the Tailscale console"))
		return
	}
	if r.Protocol != "tcp" && !ts.HTTPS {
		fail(messageError("Enable HTTPS certificates in the Tailscale console"))
		return
	}
	if r.Source == "zeabur" && !m.catalog.Contains(r) {
		fail(messageError("The selected project, environment or service is missing from the catalog. Refresh the Zeabur catalog"))
		return
	}
	if m.cfg.TailscaleKey != "" {
		if err = m.registry.Ensure(ctx, ts.Tailnet, r); err != nil {
			fail(err)
			return
		}
	} else {
		if r.CreateService {
			fail(messageError("Creating a Service requires TAILSCALE_API_KEY"))
			return
		}
		defs, e := m.tail.Services(ctx)
		if e != nil {
			fail(e)
			return
		}
		def, ok := defs["svc:"+r.Name]
		if !ok {
			fail(messageError("Service undefined or not visible to this node. Define svc:{0} and configure its access policy.", r.Name))
			return
		}
		if e = compatiblePorts(def.Ports, r.ServicePort()); e != nil {
			fail(e)
			return
		}
	}
	if rt != nil && rt.rule.SameListener(r) {
		rt.swap(r, r.Target(m.cfg.ClusterDomain))
		st.State = "advertised"
		st.AppliedRevision = r.Revision
		st.Backend = m.probe(ctx, r)
		m.setState(r.ID, st)
		return
	}
	// A mode/port change of the same Service must rebuild its listener. Close
	// before opening to also support TCP↔HTTP changes on the same public port.
	var previous *runtimeRule
	if rt != nil && rt.rule.Name == r.Name {
		previous = rt
		delete(m.running, r.ID)
		err := rt.Close()
		rt = nil
		if err != nil {
			cleanupErr := m.queueWithdrawal(previous.rule.Name, r.ID)
			fail(errors.Join(messageError("Old Service listener cleanup failed; retrying automatically"), err, cleanupErr))
			return
		}
	}
	ln, e := m.tail.Listen(ctx, r)
	if e != nil {
		if previous != nil {
			oldListener, restoreErr := m.tail.Listen(ctx, previous.rule)
			if restoreErr == nil {
				rt = startRuntime(previous.rule, oldListener, previous.target)
				m.running[r.ID] = rt
			} else {
				e = errors.Join(e, messageError("Could not restore previous endpoint: {0}", restoreErr))
			}
		}
		fail(messageError("Service advertisement failed: {0}", e))
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
	if r.Protocol == "tcp" {
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", r.Target(m.cfg.ClusterDomain).Host)
		if err != nil {
			return "unreachable"
		}
		conn.Close()
		return "reachable"
	}
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

func (value RuleStatus) MarshalJSON() ([]byte, error) {
	type plain RuleStatus
	if value.ErrorInfo == nil {
		value.ErrorInfo = displayTextMessage(value.Error)
	}
	return json.Marshal(plain(value))
}

func (value withdrawal) MarshalJSON() ([]byte, error) {
	type plain withdrawal
	if value.ErrorInfo == nil {
		value.ErrorInfo = displayTextMessage(value.Error)
	}
	return json.Marshal(plain(value))
}

func (m *Manager) WithdrawalMessages() []*MessageInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []*MessageInfo{}
	for name, p := range m.pending {
		info := p.ErrorInfo
		if info == nil {
			info = textMessage(p.Error)
		}
		var reason any = p.Error
		if info != nil {
			reason = info
		}
		out = append(out, messageInfo("svc:{0}: {1}", name, reason))
	}
	return out
}
