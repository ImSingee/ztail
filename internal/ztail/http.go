package ztail

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type attempt struct {
	Count int
	Start time.Time
}
type App struct {
	Config   Config
	Store    *Store
	Catalog  CatalogProvider
	Tail     Tailnet
	Manager  *Manager
	Assets   fs.FS
	Version  string
	mu       sync.Mutex
	attempts map[string]attempt
	cancel   context.CancelFunc
}

func NewApp(c Config, s *Store, z CatalogProvider, t Tailnet, registry Registry, assets fs.FS) *App {
	return &App{Config: c, Store: s, Catalog: z, Tail: t, Manager: NewManager(c, s, z, t, registry), Assets: assets, Version: "dev", attempts: map[string]attempt{}}
}
func (a *App) Start(ctx context.Context) {
	ctx, a.cancel = context.WithCancel(ctx)
	a.Manager.Start(ctx)
	go func() {
		_ = a.Catalog.Refresh(ctx)
		a.Manager.Wake()
		tick := time.NewTicker(5 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				_ = a.Catalog.Refresh(ctx)
				a.Manager.Wake()
			}
		}
	}()
}
func (a *App) Close() {
	if a.cancel != nil {
		a.cancel()
	}
	a.Manager.Close()
	_ = a.Tail.Close()
	_ = a.Store.Close()
}
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]string{"status": "ok", "version": a.Version})
	})
	mux.HandleFunc("GET /api/session", a.sessionInfo)
	mux.HandleFunc("POST /api/session", a.login)
	mux.Handle("DELETE /api/session", a.auth(http.HandlerFunc(a.logout)))
	mux.Handle("GET /api/settings", a.auth(http.HandlerFunc(a.settings)))
	mux.Handle("GET /api/catalog", a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, a.Catalog.Catalog()) })))
	mux.Handle("POST /api/catalog/refresh", a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := a.Catalog.Refresh(r.Context()); err != nil {
			a.fail(w, 502, err)
			return
		}
		a.Manager.Wake()
		jsonResponse(w, 200, a.Catalog.Catalog())
	})))
	mux.Handle("GET /api/tailscale", a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, a.Tail.Status(r.Context())) })))
	mux.Handle("POST /api/tailscale/connect", a.auth(http.HandlerFunc(a.connect)))
	mux.Handle("GET /api/rules", a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v, err := a.Manager.Views()
		if err != nil {
			a.fail(w, 500, err)
			return
		}
		jsonResponse(w, 200, v)
	})))
	mux.Handle("POST /api/rules", a.auth(http.HandlerFunc(a.saveRule)))
	mux.Handle("PUT /api/rules/{id}", a.auth(http.HandlerFunc(a.saveRule)))
	mux.Handle("DELETE /api/rules/{id}", a.auth(http.HandlerFunc(a.deleteRule)))
	mux.Handle("POST /api/rules/{id}/retry", a.auth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := a.Store.Get(r.PathValue("id")); err != nil {
			a.fail(w, 404, errors.New("规则不存在"))
			return
		}
		a.Manager.Wake()
		jsonResponse(w, 202, map[string]bool{"queued": true})
	})))
	mux.Handle("POST /api/probe", a.auth(http.HandlerFunc(a.probe)))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { a.fail(w, 404, errors.New("接口不存在")) })
	mux.HandleFunc("/", a.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				a.fail(w, 403, errors.New("跨站请求已拒绝"))
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
					a.fail(w, 403, errors.New("跨站请求已拒绝"))
					return
				}
			}
		}
		mux.ServeHTTP(w, r)
	})
}
func (a *App) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s, ok := a.getSession(r)
		if !ok {
			a.fail(w, 401, errors.New("请登录管理面板"))
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.CSRF)) != 1 {
				a.fail(w, 403, errors.New("会话校验失败，请刷新页面"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) getSession(r *http.Request) (session, bool) {
	cookie, err := r.Cookie("ztail_session")
	if err != nil {
		return session{}, false
	}
	return a.verifySession(cookie.Value)
}
func (a *App) sessionInfo(w http.ResponseWriter, r *http.Request) {
	s, ok := a.getSession(r)
	if ok {
		cookie, _ := r.Cookie("ztail_session")
		setSessionCookie(w, r, cookie.Value)
	}
	jsonResponse(w, 200, map[string]any{"authenticated": ok, "csrfToken": s.CSRF, "version": a.Version})
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !a.decode(w, r, &input) {
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	a.mu.Lock()
	now := time.Now()
	for k, v := range a.attempts {
		if now.Sub(v.Start) > 15*time.Minute {
			delete(a.attempts, k)
		}
	}
	at := a.attempts[ip]
	if at.Start.IsZero() {
		at.Start = now
	}
	if at.Count >= 10 {
		a.mu.Unlock()
		w.Header().Set("Retry-After", "900")
		a.fail(w, 429, errors.New("登录尝试过多，请 15 分钟后重试"))
		return
	}
	at.Count++
	a.attempts[ip] = at
	a.mu.Unlock()
	want, got := sha256.Sum256([]byte(a.Config.Password)), sha256.Sum256([]byte(input.Password))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		a.fail(w, 401, errors.New("管理员密码错误"))
		return
	}
	value, csrf := a.newSession()
	a.mu.Lock()
	delete(a.attempts, ip)
	a.mu.Unlock()
	setSessionCookie(w, r, value)
	jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": csrf, "version": a.Version})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "ztail_session", Path: "/", MaxAge: -1, HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode})
	jsonResponse(w, 200, map[string]bool{"authenticated": false})
}
func (a *App) settings(w http.ResponseWriter, r *http.Request) {
	jsonResponse(w, 200, map[string]any{"serverId": a.Config.ServerID, "nodeTag": a.Config.NodeTag(), "serviceTag": "tag:ztail-service", "clusterDomain": a.Config.ClusterDomain, "apiKeyConfigured": a.Config.TailscaleKey != "", "withdrawalErrors": a.Manager.WithdrawalErrors(), "policy": map[string]any{"tagOwners": map[string][]string{a.Config.NodeTag(): {"autogroup:admin"}, "tag:ztail-service": {"autogroup:admin"}}, "autoApprovers": map[string]any{"services": map[string][]string{"tag:ztail-service": {a.Config.NodeTag()}}}, "grants": []any{map[string]any{"src": []string{"autogroup:member", a.Config.NodeTag()}, "dst": []string{"tag:ztail-service"}, "ip": []string{"tcp:443"}}}}})
}
func (a *App) connect(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Method  string `json:"method"`
		AuthKey string `json:"authKey"`
	}
	if !a.decode(w, r, &in) {
		return
	}
	if err := a.Tail.Connect(r.Context(), in.Method, in.AuthKey); err != nil {
		a.fail(w, 400, err)
		return
	}
	a.Manager.Wake()
	jsonResponse(w, 202, map[string]bool{"started": true})
}
func (a *App) saveRule(w http.ResponseWriter, r *http.Request) {
	var rule Rule
	if !a.decode(w, r, &rule) {
		return
	}
	if r.Method == "POST" {
		rule.ID = ""
		rule.Revision = 0
	} else {
		rule.ID = r.PathValue("id")
	}
	if err := rule.Validate(); err != nil {
		a.fail(w, 400, err)
		return
	}
	if rule.Source == "zeabur" && !a.Catalog.Contains(rule) {
		a.fail(w, 400, errors.New("所选项目、环境或服务不属于配置的服务器，请刷新目录"))
		return
	}
	if rule.CreateService && a.Config.TailscaleKey == "" {
		a.fail(w, 400, errors.New("创建 Service 需要配置 TAILSCALE_API_KEY"))
		return
	}
	saved, err := a.Store.Save(rule)
	if err != nil {
		status := 409
		if errors.Is(err, sql.ErrNoRows) {
			status = 404
		}
		a.fail(w, status, err)
		return
	}
	a.Manager.Wake()
	jsonResponse(w, 200, saved)
}
func (a *App) deleteRule(w http.ResponseWriter, r *http.Request) {
	if err := a.Store.Delete(r.PathValue("id")); err != nil {
		a.fail(w, 404, errors.New("规则不存在"))
		return
	}
	a.Manager.Wake()
	jsonResponse(w, 202, map[string]bool{"queued": true})
}
func (a *App) probe(w http.ResponseWriter, r *http.Request) {
	var rule Rule
	if !a.decode(w, r, &rule) {
		return
	}
	if err := rule.Validate(); err != nil {
		a.fail(w, 400, err)
		return
	}
	if rule.Source == "zeabur" && !a.Catalog.Contains(rule) {
		a.fail(w, 400, errors.New("服务不属于当前服务器"))
		return
	}
	state := a.Manager.probe(r.Context(), rule)
	status := 200
	if state == "unreachable" {
		status = 502
	}
	jsonResponse(w, status, map[string]any{"state": state, "target": rule.Target(a.Config.ClusterDomain).String(), "error": map[bool]string{true: "后端不可达，请检查地址、端口和 TLS 证书", false: ""}[status != 200]})
}
func (a *App) decode(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		a.fail(w, 400, errors.New("请求内容无效"))
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		a.fail(w, 400, errors.New("请求只能包含一个 JSON 对象"))
		return false
	}
	return true
}
func (a *App) fail(w http.ResponseWriter, status int, err error) {
	jsonResponse(w, status, map[string]string{"error": a.Config.Redact(err.Error())})
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (a *App) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(405)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fs.Stat(a.Assets, name); err != nil {
		if strings.Contains(name, ".") {
			http.NotFound(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		r = r2
	}
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.FileServer(http.FS(a.Assets)).ServeHTTP(w, r)
}
