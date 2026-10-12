package ztail

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSessionSurvivesRestart(t *testing.T) {
	c := testConfig(t.TempDir())
	open := func(c Config) *App {
		s, err := OpenStore(c.DataDir)
		if err != nil {
			t.Fatal(err)
		}
		return NewApp(c, s, &fakeCatalog{}, newFakeTail(c.Tag), &fakeRegistry{}, nil)
	}
	call := func(app *App, method, path, body, cookie, csrf string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Cookie", cookie)
		req.Header.Set("X-CSRF-Token", csrf)
		req.Header.Set("X-Forwarded-Proto", "https")
		w := httptest.NewRecorder()
		app.Handler().ServeHTTP(w, req)
		return w
	}
	app := open(c)
	w := call(app, "POST", "/api/session", `{"password":"fixture-password"}`, "", "")
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge < 365*24*60*60 || cookie.Expires.Before(time.Now().Add(365*24*time.Hour)) || strings.Contains(cookie.Value, c.Password) {
		t.Fatal("session cookie attributes or password disclosure")
	}
	var login struct {
		CSRF string `json:"csrfToken"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil {
		t.Fatal(err)
	}
	header := cookie.Name + "=" + cookie.Value
	if w := call(app, "GET", "/api/settings", "", header, ""); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	app.Close()
	app = open(c)
	w = call(app, "GET", "/api/session", "", header, "")
	if refreshed := w.Result().Cookies(); len(refreshed) != 1 || refreshed[0].Value != cookie.Value || refreshed[0].MaxAge != cookie.MaxAge || refreshed[0].Expires.Before(cookie.Expires) {
		t.Fatal("session restoration did not refresh persistent cookie")
	}
	var restored struct {
		Authenticated bool   `json:"authenticated"`
		CSRF          string `json:"csrfToken"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &restored); err != nil || !restored.Authenticated || restored.CSRF != login.CSRF {
		t.Fatal("session and CSRF did not survive restart")
	}
	if w := call(app, "POST", "/api/catalog/refresh", `{}`, header, login.CSRF); w.Code != http.StatusOK {
		t.Fatal("restored session cannot perform mutation", w.Code)
	}
	if w := call(app, "POST", "/api/catalog/refresh", `{}`, header, "wrong"); w.Code != http.StatusForbidden {
		t.Fatal("wrong CSRF accepted", w.Code)
	}
	w = call(app, "DELETE", "/api/session", "", header, login.CSRF)
	if w.Code != http.StatusOK || !w.Result().Cookies()[0].Secure || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("HTTPS logout did not clear cookie")
	}
	// Stateless logout clears the browser cookie; a captured copy remains valid.
	if w := call(app, "GET", "/api/settings", "", header, ""); w.Code != http.StatusOK {
		t.Fatal("stateless cookie behavior changed", w.Code)
	}
	app.Close()
	c.Password = "changed-fixture-password"
	app = open(c)
	defer app.Close()
	if w := call(app, "GET", "/api/settings", "", header, ""); w.Code != http.StatusUnauthorized {
		t.Fatal("old cookie accepted after password change", w.Code)
	}
	t.Log("same cookie and CSRF survive App/store restart; valid mutation accepted, wrong CSRF rejected; logout clears Secure cookie; password change rejects copied cookie")
}

func TestSessionIntegrity(t *testing.T) {
	app := &App{Config: Config{Password: "fixture-password"}}
	value, csrf := app.newSession()
	if s, ok := app.verifySession(value); !ok || s.CSRF != csrf {
		t.Fatal("valid session rejected")
	}
	parts := strings.Split(value, ".")
	for name, invalid := range map[string]string{
		"empty":             "",
		"legacy ID":         token(),
		"password":          app.Config.Password,
		"missing signature": strings.Join(parts[:2], "."),
		"version":           strings.Replace(value, "v1.", "v2.", 1),
		"changed CSRF":      parts[0] + "." + token() + "." + parts[2],
		"changed signature": strings.Join(parts[:2], ".") + "." + strings.Repeat("A", 43),
		"invalid base64":    strings.Join(parts[:2], ".") + ".!",
		"extra part":        value + ".extra",
	} {
		t.Run(name, func(t *testing.T) {
			if _, ok := app.verifySession(invalid); ok {
				t.Fatal("invalid cookie accepted")
			}
		})
	}
	t.Log("cookie has no credential expiry; raw password, legacy ID, malformed cookies and tampered CSRF/signature rejected")
}
