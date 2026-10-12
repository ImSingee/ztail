package ztail

import (
	"context"
	"errors"
	"io"
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
	rule   Rule
	target *url.URL
	engine ruleRuntime
}

type ruleRuntime interface {
	swap(*url.URL)
	Close() error
}

func startRuntime(rule Rule, ln net.Listener, target *url.URL) *runtimeRule {
	var engine ruleRuntime
	if rule.Protocol == "tcp" {
		engine = startTCPRuntime(ln, target)
	} else {
		engine = startHTTPRuntime(ln, target)
	}
	return &runtimeRule{rule: rule, target: target, engine: engine}
}

func (rt *runtimeRule) swap(rule Rule, target *url.URL) {
	rt.engine.swap(target)
	rt.rule, rt.target = rule, target
}

func (rt *runtimeRule) Close() error { return rt.engine.Close() }

type httpRuntime struct {
	server      *http.Server
	listener    net.Listener
	connections map[net.Conn]bool
	mu          sync.Mutex
	proxy       *httputil.ReverseProxy
	handler     atomic.Pointer[httputil.ReverseProxy]
}

func startHTTPRuntime(ln net.Listener, target *url.URL) *httpRuntime {
	rt := &httpRuntime{listener: ln, connections: map[net.Conn]bool{}, proxy: NewProxy(target)}
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
func (rt *httpRuntime) swap(target *url.URL) {
	next := NewProxy(target)
	old := rt.handler.Swap(next)
	if tr, ok := old.Transport.(*http.Transport); ok {
		tr.CloseIdleConnections()
	}
	rt.proxy = next
}
func (rt *httpRuntime) Close() error {
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

// tcpRuntime forwards opaque streams, including protocols which negotiate their
// own TLS. Existing sessions keep their backend when the target changes.
type tcpRuntime struct {
	listener    net.Listener
	target      atomic.Pointer[url.URL]
	ctx         context.Context
	cancel      context.CancelFunc
	accepted    chan struct{}
	workers     sync.WaitGroup
	mu          sync.Mutex
	closed      bool
	connections map[net.Conn]struct{}
	closeOnce   sync.Once
	closeErr    error
	dialContext func(context.Context, string, string) (net.Conn, error)
}

func startTCPRuntime(ln net.Listener, target *url.URL) *tcpRuntime {
	return newTCPRuntime(ln, target, (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext)
}

func newTCPRuntime(ln net.Listener, target *url.URL, dial func(context.Context, string, string) (net.Conn, error)) *tcpRuntime {
	ctx, cancel := context.WithCancel(context.Background())
	rt := &tcpRuntime{listener: ln, ctx: ctx, cancel: cancel, accepted: make(chan struct{}), connections: map[net.Conn]struct{}{}, dialContext: dial}
	rt.target.Store(target)
	go rt.accept()
	return rt
}

func (rt *tcpRuntime) swap(target *url.URL) { rt.target.Store(target) }

func (rt *tcpRuntime) track(c net.Conn) bool {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed {
		c.Close()
		return false
	}
	rt.connections[c] = struct{}{}
	return true
}

func (rt *tcpRuntime) release(c net.Conn) {
	c.Close()
	rt.mu.Lock()
	delete(rt.connections, c)
	rt.mu.Unlock()
}

func (rt *tcpRuntime) accept() {
	defer close(rt.accepted)
	for {
		client, err := rt.listener.Accept()
		if err != nil {
			return
		}
		if !rt.track(client) {
			return
		}
		// Capture the backend at acceptance, before another revision is applied.
		target := rt.target.Load().Host
		rt.workers.Add(1)
		go func() {
			defer rt.workers.Done()
			defer rt.release(client)
			backend, err := rt.dialContext(rt.ctx, "tcp", target)
			if err != nil || !rt.track(backend) {
				return
			}
			defer rt.release(backend)
			forwardTCP(client, backend)
		}()
	}
}

func forwardTCP(client, backend net.Conn) {
	done := make(chan struct{})
	copyStream := func(dst, src net.Conn) {
		if _, err := io.Copy(dst, src); err != nil {
			client.Close()
			backend.Close()
			return
		}
		// EOF in one direction must still allow the other direction to drain.
		if half, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = half.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go func() { defer close(done); copyStream(backend, client) }()
	copyStream(client, backend)
	<-done
}

func (rt *tcpRuntime) Close() error {
	rt.closeOnce.Do(func() {
		rt.cancel()
		rt.closeErr = rt.listener.Close()
		if errors.Is(rt.closeErr, net.ErrClosed) {
			rt.closeErr = nil
		}
		rt.mu.Lock()
		rt.closed = true
		for c := range rt.connections {
			c.Close()
		}
		rt.mu.Unlock()
		// Wait for the accept loop before workers: no Add may race with Wait.
		<-rt.accepted
		rt.workers.Wait()
	})
	return rt.closeErr
}
