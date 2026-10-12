package ztail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

type fakeCatalog struct {
	cat     Catalog
	mu      sync.Mutex
	failure bool
}

func (f *fakeCatalog) Catalog() Catalog { f.mu.Lock(); defer f.mu.Unlock(); return f.cat }
func (f *fakeCatalog) Refresh(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failure {
		f.cat.Error = "Zeabur API 返回 HTTP 401"
		return errors.New(f.cat.Error)
	}
	f.cat.Error = ""
	return nil
}
func (f *fakeCatalog) Contains(r Rule) bool {
	for _, p := range f.Catalog().Projects {
		if p.ID == r.ProjectID {
			e, s := false, false
			for _, env := range p.Environments {
				e = e || env.ID == r.EnvironmentID
			}
			for _, svc := range p.Services {
				s = s || svc.ID == r.ServiceID
			}
			return e && s
		}
	}
	return false
}

type fakeTail struct {
	mu              sync.Mutex
	state           TailStatus
	defs            map[string]ServiceDefinition
	listeners       map[string]net.Listener
	ads             map[string]bool
	connects        []map[string]any
	listenCount     int
	withdrawFailure bool
	listenFailure   string
}

func newFakeTail(tag string) *fakeTail {
	return &fakeTail{state: TailStatus{State: "NeedsLogin", Tags: []string{}, IPs: []string{}}, defs: map[string]ServiceDefinition{"svc:grafana": {Name: "svc:grafana", Ports: []string{"tcp:443"}}, "svc:renamed": {Name: "svc:renamed", Ports: []string{"tcp:443"}}}, listeners: map[string]net.Listener{}, ads: map[string]bool{}}
}
func (f *fakeTail) Status(context.Context) TailStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}
func (f *fakeTail) authorize(tag string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state = TailStatus{State: "Running", Tailnet: "fixture-tailnet", DNSSuffix: "fixture.ts.net", Hostname: "ztail", NodeID: "fixture-node", Tags: []string{tag}, IPs: []string{"100.64.0.10"}, MagicDNS: true, HTTPS: true}
}
func (f *fakeTail) Connect(_ context.Context, method, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.connects = append(f.connects, map[string]any{"method": method, "authKeyPresent": key != ""})
	if method == "authkey" && key == "" {
		return errors.New("请输入 Auth Key")
	}
	f.state.AuthURL = "http://127.0.0.1:18080/fixture/authorize"
	return nil
}
func (f *fakeTail) Services(context.Context) (map[string]ServiceDefinition, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	copy := map[string]ServiceDefinition{}
	for k, v := range f.defs {
		copy[k] = v
	}
	return copy, nil
}
func (f *fakeTail) Listen(_ context.Context, name string) (net.Listener, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listenFailure == name {
		return nil, errors.New("injected listener failure")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f.listeners[name] = ln
	f.ads[name] = true
	f.listenCount++
	return ln, nil
}
func (f *fakeTail) Withdraw(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.withdrawFailure {
		return errors.New("injected withdrawal failure")
	}
	delete(f.ads, name)
	return nil
}
func (f *fakeTail) Advertisements(context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for name := range f.ads {
		out = append(out, name)
	}
	return out, nil
}
func (f *fakeTail) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ln := range f.listeners {
		_ = ln.Close()
	}
	return nil
}
func (f *fakeTail) address(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	ln := f.listeners[name]
	if ln == nil {
		return ""
	}
	return "http://" + ln.Addr().String()
}

type fakeRegistry struct {
	tail    *fakeTail
	mu      sync.Mutex
	calls   []map[string]any
	failure bool
}

func (f *fakeRegistry) Ensure(_ context.Context, tailnet, name string, create bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, map[string]any{"tailnet": tailnet, "name": name, "create": create})
	if f.failure {
		return errors.New("TAILSCALE_API_KEY 无效、已过期或没有当前 tailnet 的 Services 权限")
	}
	f.tail.mu.Lock()
	defer f.tail.mu.Unlock()
	if def, ok := f.tail.defs["svc:"+name]; ok {
		return compatiblePorts(def.Ports)
	}
	if !create {
		return errors.New("Service 尚未定义")
	}
	f.tail.defs["svc:"+name] = ServiceDefinition{Name: "svc:" + name, Ports: []string{"tcp:443"}, Tags: []string{"tag:ztail-service"}}
	return nil
}
func testConfig(dir string) Config {
	return Config{Password: "fixture-password", ZeaburKey: "fixture-zeabur-key", ServerID: "server-demo", Tag: "custom-host", ClusterDomain: "cluster.local", Port: "8080", DataDir: dir}
}
func manualRule(t *testing.T, target string) Rule {
	t.Helper()
	u, _ := url.Parse(target)
	host, port, _ := net.SplitHostPort(u.Host)
	p, _ := strconv.Atoi(port)
	return Rule{Name: "grafana", Source: "manual", Host: host, Port: p, Protocol: "http", Enabled: true}
}
func TestConfigAndTag(t *testing.T) {
	for _, key := range []string{"ADMIN_PASSWORD", "ZEABUR_API_KEY", "ZEABUR_SERVER_ID", "TAILSCALE_TAG", "PORT", "CLUSTER_DOMAIN", "DATA_DIR", "TAILSCALE_API_KEY"} {
		t.Setenv(key, "")
	}
	t.Setenv("ADMIN_PASSWORD", "demo")
	t.Setenv("ZEABUR_API_KEY", "key")
	t.Setenv("ZEABUR_SERVER_ID", "server-demo")
	c, err := LoadConfig()
	if err != nil || c.Tag != "ztail" || c.NodeTag() != "tag:ztail" {
		t.Fatal(c, err)
	}
	t.Setenv("TAILSCALE_TAG", "custom-host")
	c, err = LoadConfig()
	if err != nil || c.NodeTag() != "tag:custom-host" {
		t.Fatal(c, err)
	}
	for _, key := range []string{"ADMIN_PASSWORD", "ZEABUR_API_KEY", "ZEABUR_SERVER_ID"} {
		old := os.Getenv(key)
		t.Setenv(key, "")
		if _, err = LoadConfig(); err == nil || !strings.Contains(err.Error(), key) {
			t.Fatalf("missing %s accepted", key)
		}
		t.Setenv(key, old)
	}
	t.Setenv("TAILSCALE_TAG", "tag:ztail")
	if _, err = LoadConfig(); err == nil {
		t.Fatal("prefixed tag accepted")
	}
	t.Log("ADMIN_PASSWORD / ZEABUR_API_KEY / ZEABUR_SERVER_ID required; bare tag default ztail → tag:ztail, custom-host → tag:custom-host")
}
func TestEmbeddedAuthKeyRejectsWrongCredentialKind(t *testing.T) {
	tail := NewTailnet(testConfig(t.TempDir()))
	if err := tail.Connect(context.Background(), "authkey", "tskey-api-fixture"); err == nil {
		t.Fatal("API key accepted as node Auth Key")
	}
	if tail.server != nil {
		t.Fatal("invalid credential started node")
	}
}
func TestStorePersistenceAndConflicts(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	r := Rule{Name: "grafana", Source: "zeabur", ProjectID: "project-a", EnvironmentID: "env-second", ServiceID: "svc-a", Port: 3000, Protocol: "http"}
	r, err = s.Save(r)
	if err != nil {
		t.Fatal(err)
	}
	stale := r
	r.Enabled = true
	r, err = s.Save(r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Save(stale); !errors.Is(err, ErrConflict) {
		t.Fatal("stale update accepted", err)
	}
	duplicate := r
	duplicate.ID = ""
	if _, err = s.Save(duplicate); err == nil {
		t.Fatal("duplicate accepted")
	}
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.Get(r.ID)
	if err != nil || got.EnvironmentID != "env-second" || !got.Enabled || got.Revision != 2 {
		t.Fatal(got, err)
	}
	if got.Target("cluster.local").Host != "service-svc-a.environment-env-second.svc.cluster.local:3000" {
		t.Fatal(got.Target("cluster.local"))
	}
	t.Logf("reopened SQLite: id=%s environment=%s enabled=%v revision=%d target=%s", got.ID, got.EnvironmentID, got.Enabled, got.Revision, got.Target("cluster.local"))
}
func TestZeaburGraphQLErrorPreservesCatalog(t *testing.T) {
	mode := "ok"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-zeabur-key" {
			t.Error("missing bearer")
		}
		if mode == "error" {
			io.WriteString(w, `{"errors":[{"message":"denied"}]}`)
			return
		}
		if mode == "http" {
			w.WriteHeader(401)
			return
		}
		io.WriteString(w, `{"data":{"servers":[{"_id":"demo","name":"Server"}],"projects":{"edges":[{"node":{"_id":"project-a","name":"App","region":{"id":"server-demo"},"environments":[{"_id":"first","name":"production"},{"_id":"second","name":"preview"}],"services":[{"_id":"svc-a","name":"web"}]}},{"node":{"_id":"other","region":{"id":"server-other"}}}]}}}`)
	}))
	defer server.Close()
	z := NewZeabur(testConfig(t.TempDir()))
	z.endpoint = server.URL
	if err := z.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(z.Catalog().Projects) != 1 || len(z.Catalog().Projects[0].Environments) != 2 {
		t.Fatal(z.Catalog())
	}
	for _, m := range []string{"error", "http"} {
		mode = m
		if z.Refresh(context.Background()) == nil {
			t.Fatal("error hidden")
		}
		if len(z.Catalog().Projects) != 1 || z.Catalog().Error == "" {
			t.Fatal("cache lost")
		}
	}
	t.Log("server filtering retained one project/two environments; GraphQL errors and HTTP401 preserve last-good directory")
}
func TestTailscaleAPINeverOverwrites(t *testing.T) {
	events := []string{}
	mode := "missing"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		events = append(events, r.Method+" "+r.URL.Path)
		user, _, _ := r.BasicAuth()
		if user != "fixture-api" {
			t.Error("wrong auth")
		}
		if r.Method == "PUT" {
			var d ServiceDefinition
			json.NewDecoder(r.Body).Decode(&d)
			if d.Name != "svc:grafana" || len(d.Tags) != 1 || d.Tags[0] != "tag:ztail-service" {
				t.Error(d)
			}
			jsonResponse(w, 200, d)
			return
		}
		switch mode {
		case "missing":
			w.WriteHeader(404)
		case "existing":
			io.WriteString(w, `{"name":"svc:grafana","ports":["tcp:443"]}`)
		case "incompatible":
			io.WriteString(w, `{"ports":["tcp:443","tcp:80"]}`)
		case "invalid":
			w.WriteHeader(401)
		}
	}))
	defer server.Close()
	a := NewTailscaleAPI(Config{TailscaleKey: "fixture-api"})
	a.endpoint = server.URL
	ctx := context.Background()
	if a.Ensure(ctx, "fixture-tailnet", "grafana", false) == nil {
		t.Fatal("undefined accepted")
	}
	if err := a.Ensure(ctx, "fixture-tailnet", "grafana", true); err != nil {
		t.Fatal(err)
	}
	if events[len(events)-1] != "PUT /tailnet/fixture-tailnet/vip-services/svc:grafana" {
		t.Fatal(events)
	}
	for _, m := range []string{"existing", "incompatible", "invalid"} {
		mode = m
		before := len(events)
		err := a.Ensure(ctx, "fixture-tailnet", "grafana", true)
		if (m == "existing") != (err == nil) {
			t.Fatal(m, err)
		}
		if len(events) != before+1 || !strings.HasPrefix(events[len(events)-1], "GET ") {
			t.Fatal("existing overwritten")
		}
	}
	t.Logf("HTTP API audit: %v", events)
}
func TestZeaburPagination(t *testing.T) {
	skips := []int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Variables struct {
				Skip int `json:"skip"`
			} `json:"variables"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		skips = append(skips, in.Variables.Skip)
		id, next := "page-a", true
		if in.Variables.Skip == 1 {
			id, next = "page-b", false
		}
		jsonResponse(w, 200, map[string]any{"data": map[string]any{"servers": []NamedID{{ID: "demo", Name: "Server"}}, "projects": map[string]any{"edges": []any{map[string]any{"node": map[string]any{"_id": id, "region": map[string]string{"id": "server-demo"}}}}, "pageInfo": map[string]bool{"hasNextPage": next}}}})
	}))
	defer server.Close()
	z := NewZeabur(testConfig(t.TempDir()))
	z.endpoint = server.URL
	if err := z.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(z.Catalog().Projects) != 2 || len(skips) != 2 || skips[1] != 1 {
		t.Fatal(z.Catalog(), skips)
	}
	t.Logf("GraphQL skip progression=%v; both pages committed atomically", skips)
}
func TestManagerLifecycleAndWithdrawalRetry(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "backend-one") }))
	defer backend.Close()
	backend2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "backend-two") }))
	defer backend2.Close()
	dir := t.TempDir()
	s, _ := OpenStore(dir)
	tail := newFakeTail("custom-host")
	tail.authorize("tag:custom-host")
	m := NewManager(testConfig(dir), s, &fakeCatalog{}, tail, &fakeRegistry{tail: tail})
	ctx := context.Background()
	r, err := s.Save(manualRule(t, backend.URL))
	if err != nil {
		t.Fatal(err)
	}
	m.Reconcile(ctx)
	addr := tail.address(r.Name)
	get := func(url, want string) {
		t.Helper()
		resp, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(b) != want {
			t.Fatalf("got %s want %s", b, want)
		}
	}
	get(addr, "backend-one")
	replacement := manualRule(t, backend2.URL)
	r.Host = replacement.Host
	r.Port = replacement.Port
	r, err = s.Save(r)
	if err != nil {
		t.Fatal(err)
	}
	m.Reconcile(ctx)
	if tail.address(r.Name) != addr {
		t.Fatal("backend change replaced listener")
	}
	get(addr, "backend-two")
	tail.mu.Lock()
	tail.listenFailure = "renamed"
	tail.mu.Unlock()
	r.Name = "renamed"
	r, _ = s.Save(r)
	m.Reconcile(ctx)
	get(addr, "backend-two")
	views, _ := m.Views()
	if views[0].Status.State != "update_failed" {
		t.Fatal(views)
	}
	if views[0].Status.ActiveURL != "https://grafana.fixture.ts.net" || views[0].Status.ActiveTarget != backend2.URL {
		t.Fatal("old active endpoint hidden", views)
	}
	independent := manualRule(t, backend.URL)
	independent.Name = "healthy"
	tail.mu.Lock()
	tail.defs["svc:healthy"] = ServiceDefinition{Ports: []string{"tcp:443"}}
	tail.mu.Unlock()
	independent, _ = s.Save(independent)
	m.Reconcile(ctx)
	get(tail.address("healthy"), "backend-one")
	tail.mu.Lock()
	tail.listenFailure = ""
	tail.withdrawFailure = true
	tail.mu.Unlock()
	m.Reconcile(ctx)
	get(tail.address("renamed"), "backend-two")
	if len(m.WithdrawalErrors()) == 0 {
		t.Fatal("rename cleanup failure hidden")
	}
	r.Enabled = false
	r, _ = s.Save(r)
	m.Reconcile(ctx)
	views, _ = m.Views()
	for _, v := range views {
		if v.ID == r.ID && v.Status.State != "withdrawal_pending" {
			t.Fatal(v)
		}
	}
	if resp, err := http.Get(tail.address("renamed")); err == nil {
		resp.Body.Close()
		t.Fatal("disabled listener still accepts")
	}
	tail.mu.Lock()
	tail.withdrawFailure = false
	tail.mu.Unlock()
	m.Reconcile(ctx)
	if len(m.WithdrawalErrors()) != 0 {
		t.Fatal("withdrawal not retried")
	}
	// Persisted enabled healthy rule returns on a new manager/store. Ads left by
	// an abrupt exit are discovered and removed before listeners are restored.
	m.Close()
	s.Close()
	s, _ = OpenStore(dir)
	m = NewManager(testConfig(dir), s, &fakeCatalog{}, tail, &fakeRegistry{tail: tail})
	m.Reconcile(ctx)
	get(tail.address("healthy"), "backend-one")
	if err = s.Delete(independent.ID); err != nil {
		t.Fatal(err)
	}
	m.Reconcile(ctx)
	if resp, err := http.Get(tail.address("healthy")); err == nil {
		resp.Body.Close()
		t.Fatal("deleted listener accepts")
	}
	m.Close()
	s.Close()
	tail.Close()
	t.Log("publish→backend swap (same listener)→failed rename (old works)→independent rule works→rename cleanup failure→disable rejects new connections→withdraw retry→SQLite restart restores enabled rule→delete withdraws")
}
func TestProxyContracts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ws":
			c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			defer c.CloseNow()
			typ, data, err := c.Read(r.Context())
			if err == nil {
				c.Write(r.Context(), typ, data)
			}
		case "/sse":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: first\n\n")
			w.(http.Flusher).Flush()
			fmt.Fprint(w, "data: second\n\n")
		case "/upload":
			b, _ := io.ReadAll(r.Body)
			fmt.Fprintf(w, "%d", len(b))
		default:
			jsonResponse(w, 200, map[string]string{"path": r.URL.RequestURI(), "host": r.Host, "proto": r.Header.Get("X-Forwarded-Proto"), "for": r.Header.Get("X-Forwarded-For")})
		}
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	proxy := httptest.NewServer(NewProxy(target))
	defer proxy.Close()
	req, _ := http.NewRequest("GET", proxy.URL+"/path?q=1", nil)
	req.Host = "grafana.fixture.ts.net"
	req.Header.Set("X-Forwarded-For", "attacker")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]string
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if got["path"] != "/path?q=1" || got["host"] != req.Host || got["proto"] != "https" || strings.Contains(got["for"], "attacker") {
		t.Fatal(got)
	}
	resp, err = http.Post(proxy.URL+"/upload", "application/octet-stream", bytes.NewReader(make([]byte, 1<<20)))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "1048576" {
		t.Fatal(string(b))
	}
	resp, err = http.Get(proxy.URL + "/sse")
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(b), "first") || !strings.Contains(string(b), "second") {
		t.Fatal(string(b))
	}
	c, _, err := websocket.Dial(context.Background(), strings.Replace(proxy.URL, "http:", "ws:", 1)+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(context.Background(), websocket.MessageText, []byte("echo")); err != nil {
		t.Fatal(err)
	}
	_, b, err = c.Read(context.Background())
	if err != nil || string(b) != "echo" {
		t.Fatal(string(b), err)
	}
	tlsUp := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "untrusted") }))
	defer tlsUp.Close()
	u, _ := url.Parse(tlsUp.URL)
	tlsProxy := httptest.NewServer(NewProxy(u))
	defer tlsProxy.Close()
	resp, err = http.Get(tlsProxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 {
		t.Fatal("untrusted TLS accepted")
	}
	t.Logf("actual proxy: preserved path/query/host, HTTPS forwarded protocol, spoofed XFF removed; upload=1048576 bytes; SSE both chunks; WebSocket echo; untrusted TLS returned HTTP %d", resp.StatusCode)
}

func TestZeaburEnvironmentPortsAndPartialErrors(t *testing.T) {
	mode := "ok"
	detailsRequests := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Query     string                     `json:"query"`
			Variables map[string]json.RawMessage `json:"variables"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		if r.Header.Get("Authorization") != "Bearer fixture-zeabur-key" {
			t.Error("missing authorization")
		}
		if strings.Contains(request.Query, "projects(skip:") {
			io.WriteString(w, `{"data":{"servers":[{"_id":"demo","name":"Server"}],"projects":{"edges":[{"node":{"_id":"p","name":"App","region":{"id":"server-demo"},"environments":[{"_id":"production","name":"Production"},{"_id":"preview","name":"Preview"}],"services":[{"_id":"svc","name":"web","dnsName":"web"}]}},{"node":{"_id":"other","region":{"id":"server-other"},"environments":[{"_id":"other-env"}],"services":[{"_id":"other-svc"}]}}]}}}`)
			return
		}
		detailsRequests++
		if mode == "http" {
			w.WriteHeader(401)
			return
		}
		if !strings.Contains(request.Query, "service(_id: $s0)") || !strings.Contains(request.Query, "ports(environmentID: $e0)") {
			t.Error("wrong environment-scoped query", request.Query)
		}
		data := map[string]any{}
		for key, value := range request.Variables {
			if !strings.HasPrefix(key, "s") {
				continue
			}
			var id, env string
			json.Unmarshal(value, &id)
			json.Unmarshal(request.Variables["e"+key[1:]], &env)
			if id != "svc" || (env != "production" && env != "preview") {
				t.Errorf("wrong service/environment: %s %s", id, env)
			}
			port := 3000
			if env == "preview" {
				port = 4000
			}
			data[key] = map[string]any{"status": "RUNNING", "ports": []ServicePort{{ID: "web", Port: port, Type: "HTTP"}, {ID: "database", Port: 6379, Type: "TCP"}}}
		}
		response := map[string]any{"data": data}
		if mode == "partial" {
			data["s0"] = nil
			response["errors"] = []any{map[string]any{"message": "port permission fixture-zeabur-key", "path": []string{"s0", "ports"}}}
		}
		jsonResponse(w, 200, response)
	}))
	defer api.Close()
	z := NewZeabur(testConfig(t.TempDir()))
	z.endpoint = api.URL
	if err := z.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	envs := z.Catalog().Projects[0].Services[0].Environments
	if detailsRequests != 1 || envs["production"].Ports[0].Port != 3000 || envs["preview"].Ports[0].Port != 4000 {
		t.Fatal(detailsRequests, envs)
	}
	mode = "partial"
	if err := z.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	envs = z.Catalog().Projects[0].Services[0].Environments
	if envs["production"].Ports[0].Port != 3000 || envs["production"].Error == "" || strings.Contains(envs["production"].Error, "fixture-zeabur-key") || envs["preview"].Error != "" || z.Catalog().Error == "" {
		t.Fatal(envs)
	}
	mode = "http"
	if err := z.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	envs = z.Catalog().Projects[0].Services[0].Environments
	if envs["preview"].Ports[0].Port != 4000 || !strings.Contains(envs["preview"].Error, "401") {
		t.Fatal(envs)
	}
	t.Log("environment-scoped ports: production3000/preview4000; batched request; other-server excluded; partial GraphQL failure preserves only the affected row; HTTP401 retains stale ports with explicit error")
}
