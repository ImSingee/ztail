package ztail

import (
	"context"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/ipn"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
)

// Exercise the real tsnet/localapi/controlclient chain. fakeTail cannot detect
// a missing login trigger: it accepts every Connect without registration.
func TestAuthKeyRegistersFreshNode(t *testing.T) {
	const authKey = "tskey-auth-fixture-valid"
	control := &testcontrol.Server{RequireAuthKey: authKey, DERPMap: authTestDERP(t), Logf: t.Logf}
	control.HTTPTestServer = httptest.NewServer(control)
	defer control.HTTPTestServer.Close()
	tail := NewTailnet(testConfig(t.TempDir()))
	server := &tsnet.Server{Dir: filepath.Join(tail.cfg.DataDir, "tailscale"), Hostname: "ztail", ControlURL: control.HTTPTestServer.URL, UserLogf: tail.logf}
	tail.mu.Lock()
	err := tail.startServerLocked(server)
	tail.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	defer tail.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	wait := func(predicate func(TailStatus) bool) TailStatus {
		t.Helper()
		for {
			status := tail.Status(ctx)
			if predicate(status) {
				return status
			}
			select {
			case <-ctx.Done():
				t.Fatalf("state did not converge: %+v", status)
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	wait(func(s TailStatus) bool { return strings.Contains(s.Error, "invalid authkey") })
	lc, _ := server.LocalClient()
	prefs, _ := lc.GetPrefs(ctx)
	prefs.WantRunning = true
	if err := lc.Start(ctx, ipn.Options{AuthKey: authKey, UpdatePrefs: prefs}); err != nil {
		t.Fatal(err)
	}
	// Reproduce the old path: Start receives a valid key but never registers.
	time.Sleep(200 * time.Millisecond)
	if s := tail.Status(ctx); s.State != "NeedsLogin" || len(s.IPs) != 0 {
		t.Fatalf("expected original NeedsLogin failure, got %+v", s)
	}
	if control.NumNodes() != 0 {
		t.Fatal("Start-only unexpectedly registered a node")
	}
	tail.mu.Lock()
	tail.connectStarted = time.Now().Add(-91 * time.Second)
	tail.connectMethod = "authkey"
	tail.mu.Unlock()
	if status := tail.Status(ctx); status.Connecting || !strings.Contains(status.Error, "90 seconds") {
		t.Fatalf("pending attempt must time out visibly: %+v", status)
	}
	if err := tail.Connect(ctx, "authkey", "tskey-auth-fixture-invalid"); err != nil {
		t.Fatal(err)
	}
	failed := wait(func(s TailStatus) bool { return strings.Contains(s.Error, "invalid authkey") && !s.Connecting })
	t.Logf("invalid key is observable: state=%s error=%s", failed.State, failed.Error)
	if err := tail.Connect(ctx, "authkey", authKey); err != nil {
		t.Fatal(err)
	}
	connected := wait(func(s TailStatus) bool { return s.State == "Running" && len(s.IPs) > 0 && !s.Connecting })
	if connected.AuthURL != "" || connected.Error != "" || control.NumNodes() != 1 {
		t.Fatalf("Auth Key should complete without browser: %+v", connected)
	}
	if err := tail.Connect(ctx, "authkey", authKey); err == nil {
		t.Fatal("connected node must not be reauthorized")
	}
	// Progress has a finite foreground wait, while the SDK can keep retrying.
	tail.mu.Lock()
	tail.connectStarted = time.Now().Add(-91 * time.Second)
	tail.mu.Unlock()
	// Running still takes precedence over a stale attempt timer.
	if status := tail.Status(ctx); status.Connecting || status.Error != "" {
		t.Fatalf("running should finish attempt: %+v", status)
	}
	t.Log("old Start-only path remained NeedsLogin; valid Auth Key now registers through real SDK with IP and no browser; invalid key surfaced and retry recovered")
}

func TestTailnetDiagnosticRedaction(t *testing.T) {
	tail := NewTailnet(testConfig(t.TempDir()))
	input := "denied tskey-auth-abcd_XYZ-123 tskey-api-secret " + tail.cfg.Password
	redacted := tail.redact(input)
	if strings.Contains(redacted, "tskey-") || strings.Contains(redacted, tail.cfg.Password) {
		t.Fatal("credentials leaked in diagnostics")
	}
}

// Local relay keeps the SDK entirely within this test's control plane.
func authTestDERP(t *testing.T) *tailcfg.DERPMap {
	d := derpserver.New(key.NewNode(), t.Logf)
	server := httptest.NewTLSServer(derpserver.Handler(d))
	t.Cleanup(func() { server.CloseClientConnections(); server.Close(); d.Close() })
	return &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{
		1: {RegionID: 1, RegionCode: "test", Nodes: []*tailcfg.DERPNode{{Name: "auth-test", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", IPv6: "none", STUNPort: -1, DERPPort: server.Listener.Addr().(*net.TCPAddr).Port, InsecureForTests: true}}},
	}}
}
