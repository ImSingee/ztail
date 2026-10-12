package ztail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
	"tailscale.com/tailcfg/nodecap"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
)

func tcpBackend(t *testing.T, handle func(*net.TCPConn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); handle(c.(*net.TCPConn)) }()
		}
	}()
	return ln.Addr().String()
}

func tcpRule(address string) Rule {
	host, port, _ := net.SplitHostPort(address)
	p, _ := strconv.Atoi(port)
	return Rule{Name: "redis", Source: "manual", Host: host, Port: p, Protocol: "tcp", PublishPort: 6379, Enabled: true, CreateService: true}
}

func tcpDial(t *testing.T, address string) *net.TCPConn {
	t.Helper()
	c, err := net.DialTimeout("tcp", strings.TrimPrefix(address, "http://"), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return c.(*net.TCPConn)
}

func assertTCPBytes(t *testing.T, conn net.Conn, data []byte) {
	t.Helper()
	if _, err := conn.Write(data); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(data))
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("TCP payload changed")
	}
}

func TestTCPRuntimeStreams(t *testing.T) {
	const trailer = "backend-after-client-EOF"
	backend := tcpBackend(t, func(c *net.TCPConn) {
		io.Copy(c, c)
		io.WriteString(c, trailer)
	})
	rule := tcpRule(backend)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	rt := startRuntime(rule, ln, rule.Target("cluster.local"))
	defer rt.Close()
	var wg sync.WaitGroup
	for n := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := tcpDial(t, ln.Addr().String())
			defer c.Close()
			payload := bytes.Repeat([]byte{0, 255, byte(n), 13, 10}, 13107)
			assertTCPBytes(t, c, payload)
			if err := c.CloseWrite(); err != nil {
				t.Error(err)
				return
			}
			got, err := io.ReadAll(c)
			if err != nil || string(got) != trailer {
				t.Errorf("half-close lost response: %q %v", got, err)
			}
		}()
	}
	wg.Wait()
	c := tcpDial(t, ln.Addr().String())
	defer c.Close()
	assertTCPBytes(t, c, []byte{0, 1, 255})
	started := time.Now()
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("TCP close blocked")
	}
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("active connection survived close")
	}
	if conn, err := net.DialTimeout("tcp", ln.Addr().String(), time.Second); err == nil {
		conn.Close()
		t.Fatal("closed listener accepts")
	}
	t.Log("16 concurrent independent binary streams (65535 bytes each, including 0x00/0xff); client CloseWrite preserved full backend trailer; Close disconnected active session and rejected new connections in <1s")
}

func TestTCPRuntimeBackendFailures(t *testing.T) {
	for _, closedBackend := range []bool{false, true} {
		t.Run(fmt.Sprint(closedBackend), func(t *testing.T) {
			backend := tcpBackend(t, func(c *net.TCPConn) {})
			if closedBackend {
				ln, _ := net.Listen("tcp", "127.0.0.1:0")
				backend = ln.Addr().String()
				ln.Close()
			}
			rule := tcpRule(backend)
			ln, _ := net.Listen("tcp", "127.0.0.1:0")
			rt := startRuntime(rule, ln, rule.Target("cluster.local"))
			defer rt.Close()
			c := tcpDial(t, ln.Addr().String())
			defer c.Close()
			if _, err := c.Read(make([]byte, 1)); err == nil {
				t.Fatal("failed/closed backend left client hanging")
			}
		})
	}
	t.Log("backend immediate EOF and dial refusal both close the client, with no fabricated HTTP response")
}

func TestTCPRuntimeCancelsPendingDial(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	rule := tcpRule("127.0.0.1:1")
	rt := newTCPRuntime(ln, rule.Target("cluster.local"), func(ctx context.Context, network, address string) (net.Conn, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	defer rt.Close()
	c := tcpDial(t, ln.Addr().String())
	defer c.Close()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("dial fixture not reached")
	}
	done := make(chan error, 1)
	go func() { done <- rt.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pending dial was not canceled")
	}
	t.Log("blocked dial seam reached; closing runtime canceled its context and returned within 1s, with client closed; actual socket forwarding exercised separately")
}

func TestTCPManagerLifecycle(t *testing.T) {
	backend := tcpBackend(t, func(c *net.TCPConn) { io.WriteString(c, "one"); io.Copy(c, c) })
	backend2 := tcpBackend(t, func(c *net.TCPConn) { io.WriteString(c, "two"); io.Copy(c, c) })
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	tail := newFakeTail("custom-host")
	tail.authorize("tag:custom-host")
	tail.state.HTTPS = false
	cfg := testConfig(dir)
	cfg.TailscaleKey = "fixture-api"
	m := NewManager(cfg, s, &fakeCatalog{}, tail, &fakeRegistry{tail: tail})
	defer tail.Close()
	defer func() { m.Close(); s.Close() }()
	save := func(rule Rule) Rule {
		t.Helper()
		r, e := s.Save(rule)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	r := save(tcpRule(backend))
	m.Reconcile(t.Context())
	addr := tail.address(r.Name)
	connect := func(address, greeting string) *net.TCPConn {
		t.Helper()
		c := tcpDial(t, address)
		got := make([]byte, 3)
		if _, e := io.ReadFull(c, got); e != nil || string(got) != greeting {
			c.Close()
			t.Fatal(string(got), e)
		}
		return c
	}
	old := connect(addr, "one")
	defer old.Close()
	views, _ := m.Views()
	if views[0].Status.State != "advertised" || views[0].Status.URL != "tcp://redis.fixture.ts.net:6379" || views[0].Status.Backend != "reachable" {
		t.Fatal(views)
	}
	r.Host, r.Port = tcpRule(backend2).Host, tcpRule(backend2).Port
	r = save(r)
	m.Reconcile(t.Context())
	if tail.address(r.Name) != addr {
		t.Fatal("backend-only edit replaced listener")
	}
	assertTCPBytes(t, old, []byte("old session"))
	newConn := connect(addr, "two")
	defer newConn.Close()
	r.Name = "renamed"
	r = save(r)
	tail.mu.Lock()
	tail.defs["svc:renamed"] = ServiceDefinition{Ports: []string{"tcp:6379"}}
	tail.listenFailure = "renamed"
	tail.mu.Unlock()
	m.Reconcile(t.Context())
	views, _ = m.Views()
	if views[0].Status.State != "update_failed" || views[0].Status.ActiveURL != "tcp://redis.fixture.ts.net:6379" {
		t.Fatal(views)
	}
	assertTCPBytes(t, newConn, []byte{0, 254, 2})
	still := connect(addr, "two")
	still.Close()
	tail.mu.Lock()
	tail.listenFailure = ""
	tail.mu.Unlock()
	m.Reconcile(t.Context())
	addr = tail.address(r.Name)
	c := connect(addr, "two")
	// Simulate the administrator updating the Service definition first. ztail
	// intentionally never overwrites an existing shared definition.
	r.PublishPort = 6380
	r = save(r)
	tail.mu.Lock()
	tail.defs["svc:renamed"] = ServiceDefinition{Ports: []string{"tcp:6380"}}
	tail.mu.Unlock()
	m.Reconcile(t.Context())
	if addr == tail.address(r.Name) {
		t.Fatal("public port change reused listener")
	}
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("old session survived port change")
	}
	c.Close()
	addr = tail.address(r.Name)
	c = connect(addr, "two")
	r.Enabled = false
	r = save(r)
	m.Reconcile(t.Context())
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("disabled session survived")
	}
	c.Close()
	if c, err := net.DialTimeout("tcp", strings.TrimPrefix(addr, "http://"), time.Second); err == nil {
		c.Close()
		t.Fatal("disabled listener accepts")
	}
	ads, _ := tail.Advertisements(t.Context())
	if len(ads) != 0 {
		t.Fatal(ads)
	}
	r.Enabled = true
	r = save(r)
	m.Reconcile(t.Context())
	m.Close()
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	m = NewManager(cfg, s, &fakeCatalog{}, tail, &fakeRegistry{tail: tail})
	m.Reconcile(t.Context())
	addr = tail.address(r.Name)
	c = connect(addr, "two")
	if got, _ := s.Get(r.ID); got.PublishPort != 6380 {
		t.Fatal("public port lost", got)
	}
	if err := s.Delete(r.ID); err != nil {
		t.Fatal(err)
	}
	m.Reconcile(t.Context())
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("deleted session survived")
	}
	c.Close()
	ads, _ = tail.Advertisements(t.Context())
	if len(ads) != 0 {
		t.Fatal(ads)
	}
	t.Log("TCP published without HTTPS; existing connection stayed on old backend; new connections used new backend; failed rename kept working original endpoint; port update rebuilt listener; disable/delete closed sessions and withdrew ads; SQLite+manager restart restored public port6380 and backend")
}

func TestTCPProtocolSwitchAndPortValidation(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "web") }))
	defer backend.Close()
	cfg := testConfig(t.TempDir())
	s, _ := OpenStore(cfg.DataDir)
	defer s.Close()
	tail := newFakeTail(cfg.Tag)
	tail.authorize(cfg.NodeTag())
	defer tail.Close()
	m := NewManager(cfg, s, &fakeCatalog{}, tail, &fakeRegistry{tail: tail})
	defer m.Close()
	r := manualRule(t, backend.URL)
	r, err := s.Save(r)
	if err != nil {
		t.Fatal(err)
	}
	m.Reconcile(t.Context())
	for _, proto := range []string{"tcp", "http"} {
		before := tail.address(r.Name)
		r.Protocol = proto
		r.PublishPort = 443
		r, err = s.Save(r)
		if err != nil {
			t.Fatal(err)
		}
		if proto == "http" {
			tail.mu.Lock()
			tail.listenFailure = r.Name
			tail.listenFailureOnce = true
			tail.mu.Unlock()
			m.Reconcile(t.Context())
			views, _ := m.Views()
			if views[0].Status.State != "update_failed" || views[0].Status.ActiveURL != "tcp://grafana.fixture.ts.net:443" {
				t.Fatal("rollback did not restore TCP mode", views)
			}
			response, e := http.Get(tail.address(r.Name))
			if e != nil {
				t.Fatal("restored TCP proxy unusable", e)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if string(body) != "web" {
				t.Fatal("restored proxy forwarded wrong data", string(body))
			}
		}
		m.Reconcile(t.Context())
		if before == tail.address(r.Name) {
			t.Fatal("mode change reused HTTP/TCP listener")
		}
		resp, err := http.Get(tail.address(r.Name))
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != "web" {
			t.Fatal(string(body))
		}
	}
	for _, port := range []int{-1, 0, 65536} {
		r.Protocol = "tcp"
		r.PublishPort = port
		if r.Validate() == nil {
			t.Fatal("invalid public port allowed", port)
		}
	}
	r.Protocol = "udp"
	r.PublishPort = 443
	if r.Validate() == nil {
		t.Fatal("UDP accepted")
	}
	r.Protocol = "http"
	r.PublishPort = 6379
	if r.Validate() == nil {
		t.Fatal("non443 web endpoint allowed")
	}
	r.PublishPort = 0
	if r.PublicPort() != 443 {
		t.Fatal("legacy Web rule changed")
	}
	t.Log("HTTP→TCP→HTTP on port443 rebuilt listeners and forwarded traffic; injected HTTP listener failure restored working TCP endpoint before retry; legacy Web port443 retained; invalid public ports and UDP rejected")
}

func TestTCPServiceAPI(t *testing.T) {
	var created ServiceDefinition
	mode := "missing"
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method)
		if r.Method == "PUT" {
			json.NewDecoder(r.Body).Decode(&created)
			jsonResponse(w, 200, created)
			return
		}
		if mode == "missing" {
			w.WriteHeader(404)
			return
		}
		jsonResponse(w, 200, ServiceDefinition{Ports: []string{mode}})
	}))
	defer server.Close()
	a := NewTailscaleAPI(Config{TailscaleKey: "fixture-api"})
	a.endpoint = server.URL
	rule := tcpRule("127.0.0.1:1234")
	if err := a.Ensure(t.Context(), "fixture", rule); err != nil {
		t.Fatal(err)
	}
	if created.Name != "svc:redis" || !slices.Equal(created.Ports, []string{"tcp:6379"}) {
		t.Fatal(created)
	}
	for _, port := range []string{"tcp:6379", "tcp:443", "do-not-validate"} {
		mode = port
		before := len(requests)
		err := a.Ensure(t.Context(), "fixture", rule)
		if (err == nil) != (port != "tcp:443") || len(requests) != before+1 || requests[before] != "GET" {
			t.Fatal(port, err, requests)
		}
	}
	t.Log("API created svc:redis tcp:6379; accepted matching definition/do-not-validate; incompatible tcp:443 rejected without PUT")
}

func TestTCPServiceSDK(t *testing.T) {
	control := &testcontrol.Server{MagicDNSDomain: "tcp-fixture.ts.net", DNSConfig: &tailcfg.DNSConfig{Proxied: true}, TagOwners: map[string][]string{}, DERPMap: authTestDERP(t), Logf: t.Logf}
	control.HTTPTestServer = httptest.NewServer(control)
	defer control.HTTPTestServer.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	cfg := testConfig(t.TempDir())
	tail := NewTailnet(cfg)
	host := &tsnet.Server{Dir: filepath.Join(cfg.DataDir, "tailscale"), Hostname: "tcp-host", AuthKey: "tskey-auth-tcp-fixture", AdvertiseTags: []string{cfg.NodeTag()}, ControlURL: control.HTTPTestServer.URL, UserLogf: tail.logf}
	tail.mu.Lock()
	err := tail.startServerLocked(host)
	tail.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	defer tail.Close()
	st, err := host.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	peer := &tsnet.Server{Dir: t.TempDir(), Hostname: "tcp-client", AuthKey: "tskey-auth-tcp-fixture", ControlURL: control.HTTPTestServer.URL, UserLogf: t.Logf}
	defer peer.Close()
	if _, err = peer.Up(ctx); err != nil {
		t.Fatal(err)
	}
	lc, _ := peer.LocalClient()
	if _, err = lc.EditPrefs(ctx, &ipn.MaskedPrefs{RouteAllSet: true, Prefs: ipn.Prefs{RouteAll: true}}); err != nil {
		t.Fatal(err)
	}
	vip := netip.MustParseAddr("100.100.102.1")
	webVIP := netip.MustParseAddr("100.100.102.2")
	raw, _ := json.Marshal(tailcfg.ServiceIPMappings{"svc:redis": {vip}, "svc:web": {webVIP}})
	control.SetNodeCapMap(st.Self.PublicKey, tailcfg.NodeCapMap{nodecap.ServiceHost: {tailcfg.RawMessage(raw)}})
	control.SetSubnetRoutes(st.Self.PublicKey, []netip.Prefix{netip.PrefixFrom(vip, 32), netip.PrefixFrom(webVIP, 32)})
	control.AddDNSRecords(tailcfg.DNSRecord{Name: "redis.tcp-fixture.ts.net", Value: vip.String()}, tailcfg.DNSRecord{Name: "web.tcp-fixture.ts.net", Value: webVIP.String()})
	waitPanel(t, ctx, func() bool {
		nm := tsnet.TestHooks.LocalBackend(peer).NetMapWithPeers()
		hm := tsnet.TestHooks.LocalBackend(host).NetMapNoPeers()
		return nm != nil && hm != nil && hm.SelfNode.CapMap().Contains(nodecap.ServiceHost) && slices.ContainsFunc(nm.DNS.ExtraRecords, func(r tailcfg.DNSRecord) bool { return r.Value == vip.String() })
	})
	// testcontrol auto-adds certificate domains. Clear them in an explicit full
	// netmap to exercise a tailnet with MagicDNS but no HTTPS capability.
	netmap, err := control.MapResponse(&tailcfg.MapRequest{NodeKey: st.Self.PublicKey})
	if err != nil {
		t.Fatal(err)
	}
	netmap.DNSConfig.CertDomains = nil
	if !control.AddRawMapResponse(st.Self.PublicKey, netmap) {
		t.Fatal("could not inject no-HTTPS netmap")
	}
	waitPanel(t, ctx, func() bool { return !tail.Status(ctx).HTTPS })
	backend := tcpBackend(t, func(c *net.TCPConn) { io.Copy(c, c) })
	rule := tcpRule(backend)
	ln, err := tail.Listen(ctx, rule)
	if err != nil {
		t.Fatal(err)
	}
	rt := startRuntime(rule, ln, rule.Target("cluster.local"))
	defer rt.Close()
	// tsnet's test DNS records are fixture data. The SDK resolves the Service
	// hostname and transports traffic to its VIP; no Dial/socket is mocked.
	c, err := peer.Dial(ctx, "tcp", "redis.tcp-fixture.ts.net:6379")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	assertTCPBytes(t, c, bytes.Repeat([]byte{0, 255, 17, 0, 128}, 4096))
	if tail.Status(ctx).HTTPS {
		t.Fatal("fixture unexpectedly has HTTPS certificate capability")
	}
	webBackend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "coexisting-web") }))
	defer webBackend.Close()
	webListener, err := host.ListenService("svc:web", tsnet.ServiceModeHTTP{Port: 80})
	if err != nil {
		t.Fatal(err)
	}
	webRule := manualRule(t, webBackend.URL)
	webRuntime := startRuntime(webRule, webListener, webRule.Target("cluster.local"))
	defer webRuntime.Close()
	transport := &http.Transport{DialContext: peer.Dial}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get("http://web.tcp-fixture.ts.net:80/coexist")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "coexisting-web" {
		t.Fatal(string(body), err)
	}
	assertTCPBytes(t, c, []byte{0, 123, 255})
	hostLC, _ := host.LocalClient()
	sc, err := hostLC.GetServeConfig(ctx)
	if err != nil || sc.Services["svc:redis"].TCP[6379] == nil {
		t.Fatal("SDK TCP config missing", err, sc)
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	ads, err := tail.Advertisements(ctx)
	if err != nil || slices.Contains(ads, "redis") {
		t.Fatal("SDK did not withdraw", ads, err)
	}
	t.Logf("production EmbeddedTailnet.Listen(ServiceModeTCP) + TCP runtime: peer → fixture DNS redis.tcp-fixture.ts.net:6379 → Service VIP %s → real backend %s; 20480 binary bytes echoed exactly; HTTPS disabled; SDK HTTP VIP %s:80 coexisted using production HTTP proxy; TCP still echoed after HTTP request; close removed TCP advertisement. Local control/DERP fixtures, not a production tailnet", vip, backend, webVIP)
}
