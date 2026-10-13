package ztail

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Registry interface {
	Ensure(context.Context, string, Rule) error
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
		return nil, 0, messageError("Tailscale API unreachable")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, 0, messageError("Could not read the Tailscale API response")
	}
	return data, resp.StatusCode, nil
}
func (a *TailscaleAPI) Ensure(ctx context.Context, tailnet string, rule Rule) error {
	path := "/tailnet/" + url.PathEscape(tailnet) + "/vip-services/" + url.PathEscape("svc:"+rule.Name)
	body, status, err := a.request(ctx, "GET", path, nil)
	if err != nil {
		return err
	}
	if status == 404 {
		if !rule.CreateService {
			return messageError("Service not defined. Create it in the Tailscale console or enable API creation")
		}
		body, _ = json.Marshal(ServiceDefinition{Name: "svc:" + rule.Name, Ports: []string{rule.ServicePort()}, Tags: []string{"tag:ztail-service"}})
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
		return messageError("Tailscale API returned an invalid Service definition")
	}
	return compatiblePorts(def.Ports, rule.ServicePort())
}
func compatiblePorts(ports []string, expected string) error {
	if len(ports) == 0 {
		return nil
	}
	if len(ports) == 1 && (ports[0] == expected || ports[0] == "do-not-validate") {
		return nil
	}
	return messageError("Service must define only {0} (or do-not-validate). ztail does not overwrite existing definitions. Change the ports in the console or use a new name.", expected)
}
func (a *TailscaleAPI) apiError(status int, body []byte) error {
	info := messageInfo("Tailscale API returned HTTP {0}", status)
	if status == 401 || status == 403 {
		info = messageInfo("TAILSCALE_API_KEY is invalid, expired or lacks Services permissions for this tailnet")
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
			return messageError("Service name conflicts with an existing tailnet node. Choose another Service name and retry")
		}
		reason = tailscaleSecret.ReplaceAllString(a.redact(reason), "[redacted]")
		if chars := []rune(reason); len(chars) > 512 {
			reason = string(chars[:512]) + "…"
		}
		if reason != "" {
			info = messageInfo("{0}: {1}", info, reason)
		}
	}
	return &translatedError{info: info}
}
