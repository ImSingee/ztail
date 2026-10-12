package ztail

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
	"time"
)

// Browsers limit cookie retention. Refresh storage on session restoration;
// the signed credential itself never expires while the password is unchanged.
const cookieRetention = 400 * 24 * time.Hour

type session struct {
	CSRF string
}

// The administrator password signs the cookie so sessions survive restarts
// without storing the password in the browser or maintaining server-side state.
func (a *App) sessionSignature(payload string) []byte {
	mac := hmac.New(sha256.New, []byte(a.Config.Password))
	mac.Write([]byte("ztail-session:" + payload))
	return mac.Sum(nil)
}

func (a *App) newSession() (value, csrf string) {
	csrf = token()
	payload := "v1." + csrf
	return payload + "." + base64.RawURLEncoding.EncodeToString(a.sessionSignature(payload)), csrf
}

func (a *App) verifySession(value string) (session, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" || len(parts[1]) != 64 {
		return session{}, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(signature, a.sessionSignature(strings.Join(parts[:2], "."))) {
		return session{}, false
	}
	return session{CSRF: parts[1]}, true
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, value string) {
	http.SetCookie(w, &http.Cookie{Name: "ztail_session", Value: value, Path: "/", HttpOnly: true, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteStrictMode, MaxAge: int(cookieRetention.Seconds()), Expires: time.Now().Add(cookieRetention)})
}
