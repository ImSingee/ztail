package ztail

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"
)

// nodePanel owns the node listener, not a publishing rule or Service advertisement.
type nodePanel struct {
	tail    Tailnet
	cfg     Config
	handler http.Handler
	cancel  context.CancelFunc
	done    chan struct{}
	wake    chan struct{}

	mu     sync.Mutex
	url    string
	err    string
	server *http.Server
	served chan error
}

func newNodePanel(tail Tailnet, cfg Config, handler http.Handler) *nodePanel {
	return &nodePanel{tail: tail, cfg: cfg, handler: handler, wake: make(chan struct{}, 1)}
}

func (p *nodePanel) start(ctx context.Context) {
	ctx, p.cancel = context.WithCancel(ctx)
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		defer p.stopServer()
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			checkCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			p.reconcile(checkCtx)
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			case <-p.wake:
			}
		}
	}()
}

func (p *nodePanel) close() {
	if p.cancel != nil {
		p.cancel()
		<-p.done
	} else {
		p.stopServer()
	}
}

func (p *nodePanel) status() (string, string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.url, p.err
}

func (p *nodePanel) publish(url, message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if message != "" && message != p.err {
		log.Printf("[tailscale] Console HTTPS listener failed: %s", message)
	}
	if url != "" && url != p.url {
		log.Printf("[tailscale] Console: %s", url)
	}
	p.url, p.err = url, message
}

func (p *nodePanel) stopServer() {
	if p.server != nil {
		_ = p.server.Close()
		<-p.served
		p.server, p.served = nil, nil
	}
	p.publish("", "")
}

func (p *nodePanel) reconcile(ctx context.Context) {
	st := p.tail.Status(ctx)
	if ctx.Err() != nil {
		return
	}
	if st.State != "Running" || !st.MagicDNS || !st.HTTPS || st.DNSName == "" {
		p.stopServer()
		return
	}
	if p.server != nil {
		select {
		case <-p.served:
			// Unexpected listener closure: release the server before retrying.
			_ = p.server.Close()
			p.server, p.served = nil, nil
		default:
		}
	}
	if p.server == nil {
		ln, err := p.tail.ListenPanel(ctx)
		if err != nil {
			p.publish("", p.cfg.Redact(tailscaleSecret.ReplaceAllString(err.Error(), "[redacted]")))
			return
		}
		p.server = &http.Server{Handler: p.handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
		p.served = make(chan error, 1)
		server, served := p.server, p.served
		go func() { served <- server.Serve(ln) }()
	}
	p.publish("https://"+st.DNSName, "")
}
