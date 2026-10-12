package ztail

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

func NewProxy(target *url.URL) *httputil.ReverseProxy {
	p := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(target)
		pr.Out.Host = pr.In.Host
		pr.SetXForwarded()
		// tsnet terminates TLS before forwarding to the local HTTP handler.
		pr.Out.Header.Set("X-Forwarded-Proto", "https")
		if host, _, err := net.SplitHostPort(pr.In.RemoteAddr); err == nil {
			pr.Out.Header.Set("X-Forwarded-For", host)
		}
	}}
	p.Transport = &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConnsPerHost: 16}
	p.FlushInterval = -1
	p.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, "后端暂时不可达，请检查服务地址、端口和 TLS 证书", http.StatusBadGateway)
	}
	return p
}

type runtimeRule struct {
	rule        Rule
	server      *http.Server
	listener    net.Listener
	target      *url.URL
	connections map[net.Conn]bool
	mu          sync.Mutex
	proxy       *httputil.ReverseProxy
	handler     atomic.Pointer[httputil.ReverseProxy]
}

func startRuntime(rule Rule, ln net.Listener, target *url.URL) *runtimeRule {
	rt := &runtimeRule{rule: rule, listener: ln, target: target, connections: map[net.Conn]bool{}, proxy: NewProxy(target)}
	rt.handler.Store(rt.proxy)
	rt.server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { rt.handler.Load().ServeHTTP(w, r) }), ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, ConnState: func(c net.Conn, s http.ConnState) {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		if s == http.StateClosed {
			delete(rt.connections, c)
		} else {
			rt.connections[c] = s == http.StateHijacked
		}
	}}
	go func() { _ = rt.server.Serve(ln) }()
	return rt
}
func (rt *runtimeRule) swap(rule Rule, target *url.URL) {
	next := NewProxy(target)
	old := rt.handler.Swap(next)
	if tr, ok := old.Transport.(*http.Transport); ok {
		tr.CloseIdleConnections()
	}
	rt.proxy = next
	rt.rule = rule
	rt.target = target
}
func (rt *runtimeRule) Close() error {
	// Closing ServiceListener withdraws its advertisement; Shutdown rejects new
	// requests while allowing existing HTTP requests a bounded drain window.
	closeErr := rt.listener.Close()
	if errors.Is(closeErr, net.ErrClosed) {
		closeErr = nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := rt.server.Shutdown(ctx)
	if err != nil {
		_ = rt.server.Close()
	}
	rt.mu.Lock()
	for c, hijacked := range rt.connections {
		if hijacked {
			_ = c.Close()
		}
	}
	rt.mu.Unlock()
	if tr, ok := rt.proxy.Transport.(*http.Transport); ok {
		tr.CloseIdleConnections()
	}
	return errors.Join(closeErr, err)
}
