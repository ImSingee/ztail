package ztail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Registry interface {
	Ensure(context.Context, string, string, bool) error
}
type TailscaleAPI struct {
	key, endpoint string
	client        *http.Client
	redact        func(string) string
}

func NewTailscaleAPI(c Config) *TailscaleAPI {
	return &TailscaleAPI{key: c.TailscaleKey, endpoint: "https://api.tailscale.com/api/v2", client: &http.Client{Timeout: 15 * time.Second}, redact: c.Redact}
}
func (a *TailscaleAPI) request(ctx context.Context, method, path string, body []byte) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, a.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.SetBasicAuth(a.key, "")
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, 0, errors.New("Tailscale API 无法连接")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, 0, errors.New("无法读取 Tailscale API 响应")
	}
	return data, resp.StatusCode, nil
}
func (a *TailscaleAPI) Ensure(ctx context.Context, tailnet, name string, create bool) error {
	path := "/tailnet/" + url.PathEscape(tailnet) + "/vip-services/" + url.PathEscape("svc:"+name)
	body, status, err := a.request(ctx, "GET", path, nil)
	if err != nil {
		return err
	}
	if status == 404 {
		if !create {
			return errors.New("Service 尚未定义，请到 Tailscale 控制台创建或启用 API 创建")
		}
		body, _ = json.Marshal(ServiceDefinition{Name: "svc:" + name, Ports: []string{"tcp:443"}, Tags: []string{"tag:ztail-service"}})
		body, status, err = a.request(ctx, "PUT", path, body)
		if err != nil {
			return err
		}
		if status >= 200 && status < 300 {
			return nil
		}
		return a.apiError(status, body)
	}
	if status != 200 {
		return a.apiError(status, body)
	}
	var def ServiceDefinition
	if json.Unmarshal(body, &def) != nil {
		return errors.New("Tailscale API 返回无效 Service 定义")
	}
	return compatiblePorts(def.Ports)
}
func compatiblePorts(ports []string) error {
	if len(ports) == 0 {
		return nil
	}
	if len(ports) == 1 && (ports[0] == "tcp:443" || ports[0] == "do-not-validate") {
		return nil
	}
	return errors.New("Service 必须仅定义 tcp:443（或 do-not-validate）；ztail 不覆盖已有定义")
}
func (a *TailscaleAPI) apiError(status int, body []byte) error {
	message := fmt.Sprintf("Tailscale API 返回 HTTP %d", status)
	if status == 401 || status == 403 {
		message = "TAILSCALE_API_KEY 无效、已过期或没有当前 tailnet 的 Services 权限"
	}
	// Only expose the API's structured explanation, never an HTML/proxy body.
	var detail struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(body, &detail) == nil {
		reason := strings.TrimSpace(detail.Message)
		if reason == "" {
			reason = strings.TrimSpace(detail.Error)
		}
		if status == http.StatusBadRequest && reason == "name exists but is not a service" {
			return errors.New("Service 名称与 tailnet 中已有节点名称冲突，请修改 Service 名称后重试")
		}
		reason = tailscaleSecret.ReplaceAllString(a.redact(reason), "[redacted]")
		if chars := []rune(reason); len(chars) > 512 {
			reason = string(chars[:512]) + "…"
		}
		if reason != "" {
			message += ": " + reason
		}
	}
	return errors.New(message)
}
