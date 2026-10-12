package ztail

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"

	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/tailcfg"
	"tailscale.com/tailcfg/nodecap"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/tstest/tlstest"
)

func TestNodePanelLifecycle(t *testing.T) {
	cfg := testConfig(t.TempDir())
	tail := newFakeTail(cfg.Tag)
	panel := newNodePanel(tail, cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "panel") }))
	defer panel.close()
	ctx := t.Context()
	panel.reconcile(ctx)
	if tail.panelListenCount != 0 {
		t.Fatal("unauthorized node opened panel")
	}
	tail.authorize(cfg.NodeTag())
	tail.state.HTTPS = false
	panel.reconcile(ctx)
	if tail.panelListenCount != 0 {
		t.Fatal("HTTPS-disabled node opened panel")
	}
	tail.state.HTTPS = true
	tail.state.MagicDNS = false
	panel.reconcile(ctx)
	if tail.panelListenCount != 0 {
		t.Fatal("MagicDNS-disabled node opened panel")
	}
	tail.state.MagicDNS = true
	tail.panelFailure = true
	panel.reconcile(ctx)
	if url, err := panel.status(); url != "" || !strings.Contains(err, "listener failure") {
		t.Fatal(url, err)
	}
	tail.panelFailure = false
	panel.reconcile(ctx)
	if url, err := panel.status(); url != "https://ztail.fixture.ts.net" || err != "" {
		t.Fatal(url, err)
	}
	address := "http://" + tail.panelListener.Addr().String()
	resp, err := http.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "panel" {
		t.Fatal(string(body))
	}
	panel.reconcile(ctx)
	if tail.panelListenCount != 1 {
		t.Fatal("duplicate listener")
	}
	tail.state.DNSName = "ztail-renamed.fixture.ts.net"
	panel.reconcile(ctx)
	if url, _ := panel.status(); url != "https://ztail-renamed.fixture.ts.net" {
		t.Fatal(url)
	}
	tail.panelListener.Close()
	select {
	case <-panel.served:
	case <-time.After(time.Second):
		t.Fatal("Serve did not exit")
	}
	// Put the completion back so the reconciler can observe the closed listener.
	panel.served <- http.ErrServerClosed
	panel.reconcile(ctx)
	if tail.panelListenCount != 2 {
		t.Fatal("closed listener did not recover")
	}
	if len(tail.ads) != 0 {
		t.Fatal("panel advertised a Service")
	}
	tail.state.State = "NeedsLogin"
	panel.reconcile(ctx)
	if url, err := panel.status(); url != "" || err != "" {
		t.Fatal(url, err)
	}
	tail.state.State = "Running"
	panel.reconcile(ctx)
	address = "http://" + tail.panelListener.Addr().String()
	panel.close()
	client := &http.Client{Timeout: time.Second}
	if resp, err := client.Get(address); err == nil {
		resp.Body.Close()
		t.Fatal("closed panel still reachable")
	}
	t.Log("unconnected/MagicDNS-disabled/HTTPS-disabled: no listener; failure → visible error → automatic recovery; DNS rename retained listener; unexpected closure recovered; logout and close withdraw node endpoint without Service advertisements")
}

// Exercise the actual SDK node and two Service VIPs. Only the control plane,
// DERP relay and certificate authority are fixtures; no transport is mocked.
func TestNodePanelHTTPSCoexistsWithServices(t *testing.T) {
	const authKey = "tskey-auth-panel-fixture"
	// RequireAuthKey in testcontrol demands a key even for an already enrolled
	// node's re-registration, so omit it for this persistent-identity scenario.
	control := &testcontrol.Server{MagicDNSDomain: "panel-fixture.ts.net", DNSConfig: &tailcfg.DNSConfig{Proxied: true}, TagOwners: map[string][]string{}, DERPMap: authTestDERP(t), Logf: t.Logf}
	control.HTTPTestServer = httptest.NewServer(control)
	defer control.HTTPTestServer.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	cfg := testConfig(t.TempDir())
	tail := NewTailnet(cfg)
	host := &tsnet.Server{Dir: filepath.Join(cfg.DataDir, "tailscale"), Hostname: "ztail", AuthKey: authKey, AdvertiseTags: []string{cfg.NodeTag()}, ControlURL: control.HTTPTestServer.URL, UserLogf: tail.logf}
	tail.mu.Lock()
	err := tail.startServerLocked(host)
	tail.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	defer tail.Close()
	hostStatus, err := host.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	tsnet.TestHooks.LocalBackend(host).ForTest().ConfigureCerts(func(name string) (*ipnlocal.TLSCertKeyPair, error) {
		domain := tlstest.Domain(name)
		return &ipnlocal.TLSCertKeyPair{CertPEM: domain.CertPEM(), KeyPEM: domain.KeyPEM()}, nil
	})
	clientNode := &tsnet.Server{Dir: t.TempDir(), Hostname: "panel-client", AuthKey: authKey, ControlURL: control.HTTPTestServer.URL, UserLogf: t.Logf}
	defer clientNode.Close()
	if _, err := clientNode.Up(ctx); err != nil {
		t.Fatal(err)
	}
	lc, _ := clientNode.LocalClient()
	if _, err := lc.EditPrefs(ctx, &ipn.MaskedPrefs{RouteAllSet: true, Prefs: ipn.Prefs{RouteAll: true}}); err != nil {
		t.Fatal(err)
	}
	vipOne, vipTwo := netip.MustParseAddr("100.100.101.1"), netip.MustParseAddr("100.100.101.2")
	mappings := tailcfg.ServiceIPMappings{"svc:panel-one": {vipOne}, "svc:panel-two": {vipTwo}}
	raw, _ := json.Marshal(mappings)
	capMap := tailcfg.NodeCapMap{nodecap.ServiceHost: {tailcfg.RawMessage(raw)}}
	control.SetNodeCapMap(hostStatus.Self.PublicKey, capMap)
	control.SetSubnetRoutes(hostStatus.Self.PublicKey, []netip.Prefix{netip.PrefixFrom(vipOne, 32), netip.PrefixFrom(vipTwo, 32)})
	control.AddDNSRecords(tailcfg.DNSRecord{Name: "panel-one.panel-fixture.ts.net", Value: vipOne.String()}, tailcfg.DNSRecord{Name: "panel-two.panel-fixture.ts.net", Value: vipTwo.String()})
	waitPanel(t, ctx, func() bool {
		hostMap := tsnet.TestHooks.LocalBackend(host).NetMapNoPeers()
		clientMap := tsnet.TestHooks.LocalBackend(clientNode).NetMapWithPeers()
		return hostMap != nil && hostMap.SelfNode.CapMap().Contains(nodecap.ServiceHost) && clientMap != nil && slices.ContainsFunc(clientMap.DNS.ExtraRecords, func(r tailcfg.DNSRecord) bool { return r.Value == vipTwo.String() })
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "backend:"+r.URL.Path) }))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	for _, name := range []string{"panel-one", "panel-two"} {
		ln, e := tail.Listen(ctx, name)
		if e != nil {
			t.Fatal(e)
		}
		rt := startRuntime(Rule{Name: name, Protocol: "http"}, ln, target)
		defer rt.Close()
	}
	hostLC, _ := host.LocalClient()
	before, _ := hostLC.GetServeConfig(ctx)
	prefsBefore, _ := hostLC.GetPrefs(ctx)
	store, err := OpenStore(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp(cfg, store, &fakeCatalog{}, tail, &fakeRegistry{}, fstest.MapFS{"index.html": {Data: []byte("<html><body>node panel</body></html>")}})
	// Start the panel owner independently so the rule manager does not withdraw
	// the two Services deliberately created outside its store in this fixture.
	app.panel.start(ctx)
	defer app.Close()
	waitPanel(t, ctx, func() bool { return app.tailStatus(ctx).PanelURL != "" })
	panelURL := app.tailStatus(ctx).PanelURL
	root := x509.NewCertPool()
	root.AppendCertsFromPEM(tlstest.TestRootCA())
	addresses := map[string]string{strings.TrimPrefix(panelURL, "https://"): hostStatus.TailscaleIPs[0].String(), "panel-one.panel-fixture.ts.net": vipOne.String(), "panel-two.panel-fixture.ts.net": vipTwo.String()}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: root}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		hostname, port, _ := net.SplitHostPort(address)
		return clientNode.Dial(ctx, network, net.JoinHostPort(addresses[hostname], port))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	request := func(method, address, body string, cookie *http.Cookie, csrf string) *http.Response {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, address, strings.NewReader(body))
		if cookie != nil {
			req.AddCookie(cookie)
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(method, address, err)
		}
		t.Logf("%s %s → HTTP %d", method, address, resp.StatusCode)
		return resp
	}
	// Wait for the relay/data path before judging the endpoint.
	waitPanel(t, ctx, func() bool {
		resp, e := client.Get(panelURL + "/healthz")
		if e != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == 200
	})
	for _, name := range []string{"panel-one", "panel-two"} {
		resp := request("GET", "https://"+name+".panel-fixture.ts.net/check", "", nil, "")
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || string(body) != "backend:/check" {
			t.Fatal(resp.StatusCode, string(body))
		}
	}
	resp := request("GET", panelURL, "", nil, "")
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "node panel") {
		t.Fatal(resp.StatusCode, string(body))
	}
	if resp.TLS == nil || len(resp.TLS.VerifiedChains) == 0 {
		t.Fatal("TLS not verified")
	}
	resp = request("GET", panelURL+"/api/settings", "", nil, "")
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("anonymous access accepted")
	}
	resp = request("POST", panelURL+"/api/session", `{"password":"wrong"}`, nil, "")
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("wrong password accepted")
	}
	resp = request("POST", panelURL+"/api/session", `{"password":"fixture-password"}`, nil, "")
	var session struct {
		CSRF string `json:"csrfToken"`
	}
	json.NewDecoder(resp.Body).Decode(&session)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(resp.Cookies()) != 1 {
		t.Fatal("login failed")
	}
	cookie := resp.Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("cookie flags", cookie.Secure, cookie.HttpOnly, cookie.SameSite)
	}
	resp = request("GET", panelURL+"/api/settings", "", cookie, "")
	var settings struct {
		Policy struct {
			Grants []struct {
				Dst []string `json:"dst"`
				IP  []string `json:"ip"`
			} `json:"grants"`
		} `json:"policy"`
	}
	json.NewDecoder(resp.Body).Decode(&settings)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(settings.Policy.Grants) != 2 || settings.Policy.Grants[1].Dst[0] != cfg.NodeTag() || settings.Policy.Grants[1].IP[0] != "tcp:443" {
		t.Fatal("node grant missing", settings)
	}
	resp = request("POST", panelURL+"/api/catalog/refresh", `{}`, cookie, "")
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("missing CSRF accepted")
	}
	resp = request("POST", panelURL+"/api/catalog/refresh", `{}`, cookie, session.CSRF)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("CSRF mutation failed")
	}
	after, _ := hostLC.GetServeConfig(ctx)
	prefsAfter, _ := hostLC.GetPrefs(ctx)
	beforeJSON, _ := json.Marshal(before)
	afterJSON, _ := json.Marshal(after)
	if string(beforeJSON) != string(afterJSON) || !slices.Equal(prefsBefore.AdvertiseServices, prefsAfter.AdvertiseServices) {
		t.Fatal("panel changed Service config or advertisements")
	}
	// A second owner after shutdown models restoring the same enrolled node.
	app.panel.close()
	app.panel = newNodePanel(tail, cfg, app.Handler())
	app.panel.start(ctx)
	waitPanel(t, ctx, func() bool { return app.tailStatus(ctx).PanelURL == panelURL })
	resp = request("GET", panelURL+"/healthz", "", nil, "")
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal("panel restart failed")
	}
	app.panel.close()
	transport.CloseIdleConnections()
	if resp, err := client.Get(panelURL + "/healthz"); err == nil {
		resp.Body.Close()
		t.Fatal("closed node endpoint still reachable")
	}
	app.Close()
	restoredTail := NewTailnet(cfg)
	restoredHost := &tsnet.Server{Dir: host.Dir, Hostname: "ztail", AdvertiseTags: []string{cfg.NodeTag()}, ControlURL: control.HTTPTestServer.URL, UserLogf: restoredTail.logf}
	restoredTail.mu.Lock()
	err = restoredTail.startServerLocked(restoredHost)
	restoredTail.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	tsnet.TestHooks.LocalBackend(restoredHost).ForTest().ConfigureCerts(func(name string) (*ipnlocal.TLSCertKeyPair, error) {
		domain := tlstest.Domain(name)
		return &ipnlocal.TLSCertKeyPair{CertPEM: domain.CertPEM(), KeyPEM: domain.KeyPEM()}, nil
	})
	restoredStore, err := OpenStore(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	restored := NewApp(cfg, restoredStore, &fakeCatalog{}, restoredTail, &fakeRegistry{}, app.Assets)
	restored.Start(ctx)
	defer restored.Close()
	waitPanel(t, ctx, func() bool { return restored.tailStatus(ctx).PanelURL == panelURL })
	resp = request("GET", panelURL+"/healthz", "", nil, "")
	resp.Body.Close()
	if resp.StatusCode != 200 || control.NumNodes() != 2 {
		t.Fatal("persisted node failed to resume without Auth Key", resp.StatusCode, control.NumNodes())
	}
	t.Logf("verified node HTTPS %s and two distinct VIPs %s:443 / %s:443; trusted fixture CA, password and CSRF enforced, Secure/HttpOnly/Strict cookie, two Service configs+advertisements unchanged, enrolled-node panel restart and close", panelURL, vipOne, vipTwo)
	t.Log("full App.Start restored persistent node identity and node HTTPS endpoint without Auth Key or a new node registration")
}

func waitPanel(t *testing.T, ctx context.Context, predicate func() bool) {
	t.Helper()
	for !predicate() {
		select {
		case <-ctx.Done():
			t.Fatal("panel state did not converge:", ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
}
