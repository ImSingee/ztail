package ztail

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMessageMetadata(t *testing.T) {
	cause := errors.New("upstream {1} tskey-secret")
	err := messageError("Service advertisement failed: {0}", messageError("Could not restore previous endpoint: {0}", cause))
	if !errors.Is(err, cause) {
		t.Fatal("wrapped error identity lost")
	}
	info := redactMessage(errorMessage(err), func(s string) string { return strings.ReplaceAll(s, "tskey-secret", "[redacted]") })
	body, e := json.Marshal(info)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(body), "tskey-secret") {
		t.Fatal("secret leaked in metadata")
	}
	var restored MessageInfo
	if e = json.Unmarshal(body, &restored); e != nil {
		t.Fatal(e)
	}
	if got := restored.Text(); got != "Service advertisement failed: Could not restore previous endpoint: upstream {1} [redacted]" {
		t.Fatal(got)
	}
	policy := messageError("Service must define only {0} (or do-not-validate). ztail does not overwrite existing definitions. Change the ports in the console or use a new name.", "tcp:6379")
	joined := errorMessage(errors.Join(policy, cause))
	if joined.Action != "policy" || !strings.Contains(joined.Text(), "upstream {1}") {
		t.Fatal(joined)
	}
}
func TestHTTPStructuredError(t *testing.T) {
	app := &App{Config: Config{Password: "fixture-secret"}}
	response := httptest.NewRecorder()
	app.fail(response, 502, messageError("Service advertisement failed: {0}", errors.New("upstream fixture-secret {1}")))
	if response.Code != 502 || response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatal(response)
	}
	if strings.Contains(response.Body.String(), "fixture-secret") {
		t.Fatal("HTTP metadata leaked credential")
	}
	var body struct {
		Error string       `json:"error"`
		Info  *MessageInfo `json:"errorInfo"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Info.Key != "Service advertisement failed: {0}" || body.Info.Args[0] != "upstream [redacted] {1}" || body.Info.Text() != body.Error {
		t.Fatal(body)
	}
}
