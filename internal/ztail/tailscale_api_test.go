package ztail

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTailscaleAPICreationError(t *testing.T) {
	puts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		puts++
		jsonResponse(w, 400, map[string]string{"message": "invalid service tags"})
	}))
	defer server.Close()
	a := NewTailscaleAPI(Config{TailscaleKey: "fixture-api"})
	a.endpoint = server.URL
	err := a.Ensure(context.Background(), "fixture-tailnet", Rule{Name: "new-service", Protocol: "http", CreateService: true})
	if puts != 1 || err == nil || !strings.Contains(err.Error(), "HTTP 400: invalid service tags") {
		t.Fatal("creation error explanation lost", puts, err)
	}
}

func TestTailscaleAPIErrorDetails(t *testing.T) {
	a := NewTailscaleAPI(Config{Password: "fixture-password", TailscaleKey: "fixture-api"})
	for _, tc := range []struct{ body, want string }{
		{`{"message":"name exists but is not a service"}`, "已有节点名称冲突"},
		{`{"message":"invalid service tags"}`, "HTTP 400: invalid service tags"},
		{`{"error":"invalid port"}`, "HTTP 400: invalid port"},
		{`{"message":"denied fixture-api fixture-password tskey-auth-transient"}`, "HTTP 400: denied [redacted] [redacted] [redacted]"},
		{`<html>private upstream debug</html>`, "Tailscale API 返回 HTTP 400"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			got := a.apiError(400, []byte(tc.body)).Error()
			if !strings.Contains(got, tc.want) || strings.Contains(got, "private upstream") {
				t.Fatal(got)
			}
		})
	}
	if got := a.apiError(403, []byte(`{"message":"access denied"}`)).Error(); !strings.Contains(got, "Services 权限: access denied") {
		t.Fatal(got)
	}
}
