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
	"time"
)

type Registry interface {
	Ensure(context.Context, string, string, bool) error
}
type TailscaleAPI struct {
	key, endpoint string
	client        *http.Client
}

func NewTailscaleAPI(c Config) *TailscaleAPI {
	return &TailscaleAPI{key: c.TailscaleKey, endpoint: "https://api.tailscale.com/api/v2", client: &http.Client{Timeout: 15 * time.Second}}
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
		_, status, err = a.request(ctx, "PUT", path, body)
		if err != nil {
			return err
		}
		if status >= 200 && status < 300 {
			return nil
		}
		return apiError(status)
	}
	if status != 200 {
		return apiError(status)
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
func apiError(status int) error {
	if status == 401 || status == 403 {
		return errors.New("TAILSCALE_API_KEY 无效、已过期或没有当前 tailnet 的 Services 权限")
	}
	return fmt.Errorf("Tailscale API 返回 HTTP %d", status)
}
