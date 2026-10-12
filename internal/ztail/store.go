package ztail

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Rule struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Source        string `json:"source"`
	ProjectID     string `json:"projectId"`
	EnvironmentID string `json:"environmentId"`
	ServiceID     string `json:"serviceId"`
	Host          string `json:"host"`
	Protocol      string `json:"protocol"`
	Port          int    `json:"port"`
	PublishPort   int    `json:"publishPort"`
	Enabled       bool   `json:"enabled"`
	CreateService bool   `json:"createService"`
	Revision      int64  `json:"revision"`
	UpdatedAt     string `json:"updatedAt"`
}

func (r Rule) Validate() error {
	if !labelPattern.MatchString(r.Name) {
		return messageError("Names must contain 1\u201363 lowercase letters, digits or hyphens, with no leading or trailing hyphen")
	}
	if r.Protocol != "http" && r.Protocol != "https" && r.Protocol != "tcp" {
		return messageError("Backend protocol must be HTTP, HTTPS or TCP")
	}
	if r.Port < 1 || r.Port > 65535 {
		return messageError("Port must be between 1 and 65535")
	}
	if r.PublishPort < 0 || r.PublishPort > 65535 || (r.Protocol == "tcp" && r.PublishPort == 0) {
		return messageError("Published port must be between 1 and 65535")
	}
	if r.Protocol != "tcp" && r.PublicPort() != 443 {
		return messageError("HTTP/HTTPS services must use published port 443")
	}
	switch r.Source {
	case "zeabur":
		for _, id := range []string{r.ProjectID, r.EnvironmentID, r.ServiceID} {
			if !labelPattern.MatchString(id) {
				return messageError("Select a valid project, environment and service")
			}
		}
	case "manual":
		if r.Host == "" || strings.TrimSpace(r.Host) != r.Host || strings.ContainsAny(r.Host, "/@?#:% \\\t\r\n") {
			if net.ParseIP(r.Host) == nil {
				return messageError("Enter only a backend hostname or IP; set protocol and port separately")
			}
		}
		if net.ParseIP(r.Host) == nil {
			for _, part := range strings.Split(r.Host, ".") {
				if !labelPattern.MatchString(part) {
					return messageError("Invalid backend hostname")
				}
			}
		}
	default:
		return messageError("Select a backend source")
	}
	return nil
}

// PublicPort preserves pre-TCP rules, which have no publishPort in their JSON.
func (r Rule) PublicPort() int {
	if r.PublishPort != 0 {
		return r.PublishPort
	}
	if r.Protocol == "tcp" {
		return r.Port
	}
	return 443
}

func (r Rule) ServicePort() string { return "tcp:" + strconv.Itoa(r.PublicPort()) }

func (r Rule) AccessURL(suffix string) string {
	if suffix == "" {
		return ""
	}
	host := r.Name + "." + suffix
	if r.Protocol == "tcp" {
		return "tcp://" + net.JoinHostPort(host, strconv.Itoa(r.PublicPort()))
	}
	return "https://" + host
}

func (r Rule) SameListener(other Rule) bool {
	return r.Name == other.Name && r.PublicPort() == other.PublicPort() && (r.Protocol == "tcp") == (other.Protocol == "tcp")
}
func (r Rule) Target(domain string) *url.URL {
	host := r.Host
	if r.Source == "zeabur" {
		host = "service-" + r.ServiceID + ".environment-" + r.EnvironmentID + ".svc." + domain
	}
	return &url.URL{Scheme: r.Protocol, Host: net.JoinHostPort(host, strconv.Itoa(r.Port))}
}

type Store struct{ db *sql.DB }

var ErrConflict = messageError("This rule has changed. Refresh and retry")

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "ztail.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) List() ([]Rule, error) {
	rows, err := s.db.Query("SELECT body FROM rules ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Rule{}
	for rows.Next() {
		var body string
		if err = rows.Scan(&body); err != nil {
			return nil, err
		}
		var r Rule
		if err = json.Unmarshal([]byte(body), &r); err != nil {
			return nil, err
		}
		list = append(list, r)
	}
	return list, rows.Err()
}
func (s *Store) Get(id string) (Rule, error) {
	var body string
	err := s.db.QueryRow("SELECT body FROM rules WHERE id=?", id).Scan(&body)
	var r Rule
	if err == nil {
		err = json.Unmarshal([]byte(body), &r)
	}
	return r, err
}
func (s *Store) Save(r Rule) (Rule, error) {
	if err := r.Validate(); err != nil {
		return r, err
	}
	// Save the selected public port so changing a TCP backend's port does not
	// silently move the published endpoint.
	r.PublishPort = r.PublicPort()
	tx, err := s.db.Begin()
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	if r.ID == "" {
		r.ID = token()
		r.Revision = 1
	} else {
		var body string
		if err = tx.QueryRow("SELECT body FROM rules WHERE id=?", r.ID).Scan(&body); err != nil {
			return r, err
		}
		var old Rule
		if err = json.Unmarshal([]byte(body), &old); err != nil {
			return r, err
		}
		if old.Revision != r.Revision {
			return r, ErrConflict
		}
		r.Revision++
	}
	r.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	body, err := json.Marshal(r)
	if err != nil {
		return r, err
	}
	_, err = tx.Exec("INSERT INTO rules(id,name,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body", r.ID, r.Name, string(body))
	if err != nil {
		return r, messageError("Name already in use or rule could not be saved: {0}", err)
	}
	return r, tx.Commit()
}
func (s *Store) Delete(id string) error {
	res, err := s.db.Exec("DELETE FROM rules WHERE id=?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}
func (s *Store) Setting(key string) (string, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key=?", key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}
func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value)
	return err
}
func token() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
