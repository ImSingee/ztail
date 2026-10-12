package ztail

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ImSingee/ztail/web"
)

func TestManagementSecurity(t *testing.T) {
	c := testConfig(t.TempDir())
	s, _ := OpenStore(c.DataDir)
	app := NewApp(c, s, &fakeCatalog{}, newFakeTail(c.Tag), &fakeRegistry{}, nil)
	defer app.Close()
	handler := app.Handler()
	call := func(method, path, body, cookie, csrf string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	if w := call("GET", "/api/settings", "", "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	if w := call("POST", "/api/session", `{"password":"wrong"}`, "", ""); w.Code != 401 {
		t.Fatal(w.Code)
	}
	w := call("POST", "/api/session", `{"password":"fixture-password"}`, "", "")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var sess map[string]any
	json.Unmarshal(w.Body.Bytes(), &sess)
	csrf := sess["csrfToken"].(string)
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal(cookie)
	}
	cookies := cookie.String()
	if w = call("POST", "/api/catalog/refresh", `{}`, cookies, ""); w.Code != 403 {
		t.Fatal("missing CSRF allowed")
	}
	req := httptest.NewRequest("POST", "/api/catalog/refresh", strings.NewReader(`{}`))
	req.Header.Set("Cookie", cookies)
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Origin", "https://attacker.example")
	out := httptest.NewRecorder()
	handler.ServeHTTP(out, req)
	if out.Code != 403 {
		t.Fatal("cross site allowed")
	}
	w = call("GET", "/api/settings", "", cookies, "")
	if w.Code != 200 || strings.Contains(w.Body.String(), c.Password) || strings.Contains(w.Body.String(), c.ZeaburKey) || !strings.Contains(w.Body.String(), "tag:custom-host") {
		t.Fatal(w.Body.String())
	}
	w = call("DELETE", "/api/session", "", cookies, csrf)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = call("GET", "/api/settings", "", cookies, ""); w.Code != 401 {
		t.Fatal("logout not revoked")
	}
	t.Log("real HTTP handlers: protected GET401, wrong password401, login200 + HttpOnly/Strict cookie, missing CSRF403, cross-Origin403, config redacted/custom tag, logout revokes session")
}

// This harness is compiled only into test binaries. Production has no mock
// environment switch or fixture HTTP endpoints.
func TestBrowserServer(t *testing.T) {
	if os.Getenv("ZTAIL_E2E") != "1" {
		t.Skip("browser fixture explicitly enabled only for E2E")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	upstream := &http.Server{Addr: "127.0.0.1:18082", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "fixture backend: "+r.URL.Path) })}
	ln, err := net.Listen("tcp", upstream.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go upstream.Serve(ln)
	defer upstream.Close()
	assets, err := fs.Sub(web.Assets, "dist")
	if err != nil {
		t.Fatal(err)
	}
	for _, port := range []string{"18080", "18090"} {
		c := testConfig(t.TempDir())
		if port == "18090" {
			c.TailscaleKey = "fixture-api-key"
		}
		var mu sync.RWMutex
		var app *App
		var tail *fakeTail
		var catalog *fakeCatalog
		var registry *fakeRegistry
		reset := func() {
			if app != nil {
				app.Close()
			}
			store, e := OpenStore(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			tail = newFakeTail(c.Tag)
			catalog = &fakeCatalog{cat: Catalog{Server: NamedID{ID: "server-demo", Name: "Demo Dedicated Server"}, UpdatedAt: time.Now().UTC().Format(time.RFC3339), Projects: []Project{{NamedID: NamedID{ID: "project-a", Name: "Monitoring"}, Environments: []NamedID{{ID: "env-first", Name: "Production"}, {ID: "env-second", Name: "Preview"}}, Services: []Service{{NamedID: NamedID{ID: "service-a", Name: "Grafana"}, DNSName: "grafana", Environments: map[string]ServiceEnvironment{
				"env-first":  {Status: "RUNNING", Ports: []ServicePort{{ID: "web", Port: 3000, Type: "HTTP"}, {ID: "metrics", Port: 9090, Type: "TCP"}}},
				"env-second": {Status: "RUNNING", Ports: []ServicePort{{ID: "web", Port: 4000, Type: "HTTP"}, {ID: "secure", Port: 4443, Type: "HTTPS"}}},
			}}, {NamedID: NamedID{ID: "service-db", Name: "Redis"}, DNSName: "redis", Environments: map[string]ServiceEnvironment{
				"env-first":  {Status: "RUNNING", Ports: []ServicePort{{ID: "db", Port: 6379, Type: "TCP"}, {ID: "discovery", Port: 5353, Type: "UDP"}}},
				"env-second": {Status: "NOT_DEPLOYED", Ports: []ServicePort{}},
			}}}}}}}
			registry = &fakeRegistry{tail: tail}
			app = NewApp(c, store, catalog, tail, registry, assets)
			app.Version = "e2e-" + os.Getenv("ZTAIL_BUILD_ID")
			app.Start(ctx)
		}
		reset()
		mux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/fixture/reset" {
				mu.Lock()
				defer mu.Unlock()
				reset()
				jsonResponse(w, 200, map[string]bool{"reset": true})
				return
			}
			mu.RLock()
			defer mu.RUnlock()
			switch r.URL.Path {
			case "/fixture/authorize":
				tail.authorize(c.NodeTag())
				app.Manager.Wake()
				w.Header().Set("Content-Type", "text/html")
				io.WriteString(w, "<!doctype html><html><body><p>Fixture authorization complete</p></body></html>")
			case "/fixture/audit":
				tail.mu.Lock()
				ads := []string{}
				addresses := map[string]string{}
				for name := range tail.ads {
					ads = append(ads, name)
				}
				for name, l := range tail.listeners {
					addresses[name] = "http://" + l.Addr().String()
				}
				connects := append([]map[string]any{}, tail.connects...)
				count := tail.listenCount
				tail.mu.Unlock()
				registry.mu.Lock()
				calls := append([]map[string]any{}, registry.calls...)
				registry.mu.Unlock()
				rules, _ := app.Store.List()
				jsonResponse(w, 200, map[string]any{"ads": ads, "addresses": addresses, "connects": connects, "listenCount": count, "registryCalls": calls, "rules": rules})
			case "/fixture/failure":
				which := r.URL.Query().Get("kind")
				enabled := r.URL.Query().Get("enabled") != "false"
				if which == "catalog" {
					catalog.mu.Lock()
					catalog.failure = enabled
					catalog.mu.Unlock()
				}
				if which == "ports" {
					catalog.mu.Lock()
					cat := catalog.cat
					cat.Projects = append([]Project(nil), cat.Projects...)
					cat.Projects[0].Services = append([]Service(nil), cat.Projects[0].Services...)
					cat.Projects[0].Services[0].Environments = maps.Clone(cat.Projects[0].Services[0].Environments)
					details := cat.Projects[0].Services[0].Environments["env-second"]
					if enabled {
						details.Error = "端口详情读取失败"
					} else {
						details.Error = ""
					}
					cat.Projects[0].Services[0].Environments["env-second"] = details
					catalog.cat = cat
					catalog.mu.Unlock()
				}
				if which == "registry" {
					registry.mu.Lock()
					registry.failure = enabled
					registry.mu.Unlock()
				}
				if which == "withdrawal" {
					tail.mu.Lock()
					tail.withdrawFailure = enabled
					tail.mu.Unlock()
				}
				app.Manager.Wake()
				jsonResponse(w, 200, map[string]bool{"injected": enabled})
			default:
				app.Handler().ServeHTTP(w, r)
			}
		})
		server := &http.Server{Addr: "127.0.0.1:" + port, Handler: mux}
		listen, e := net.Listen("tcp", server.Addr)
		if e != nil {
			t.Fatal(e)
		}
		go server.Serve(listen)
		defer server.Close()
		defer func() { mu.Lock(); defer mu.Unlock(); app.Close() }()
	}
	fmt.Println("ZTAIL_E2E_READY ports=18080,18090 backend=18082 build=" + os.Getenv("ZTAIL_BUILD_ID"))
	<-ctx.Done()
}
