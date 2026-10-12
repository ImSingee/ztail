package main

import (
	"context"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ImSingee/ztail/internal/ztail"
	"github.com/ImSingee/ztail/web"
)

var version = "dev"

func main() {
	c, err := ztail.LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	store, err := ztail.OpenStore(c.DataDir)
	if err != nil {
		log.Fatal("cannot open data directory: ", err)
	}
	assets, err := fs.Sub(web.Assets, "dist")
	if err != nil {
		log.Fatal(err)
	}
	app := ztail.NewApp(c, store, ztail.NewZeabur(c), ztail.NewTailnet(c), ztail.NewTailscaleAPI(c), assets)
	app.Version = version
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	app.Start(ctx)
	server := &http.Server{Addr: ":" + c.Port, Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("ztail %s listening on :%s", version, c.Port)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("HTTP server stopped: %v", err)
	}
	stop()
	app.Close()
}
