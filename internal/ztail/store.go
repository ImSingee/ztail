package ztail

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	Enabled       bool   `json:"enabled"`
	CreateService bool   `json:"createService"`
	Revision      int64  `json:"revision"`
	UpdatedAt     string `json:"updatedAt"`
}

func (r Rule) Validate() error {
	if !labelPattern.MatchString(r.Name) {
		return errors.New("名称需为 1–63 位小写字母、数字或连字符，首尾不能为连字符")
	}
	if r.Protocol != "http" && r.Protocol != "https" {
		return errors.New("后端协议必须为 HTTP 或 HTTPS")
	}
	if r.Port < 1 || r.Port > 65535 {
		return errors.New("端口必须在 1–65535 之间")
	}
	switch r.Source {
	case "zeabur":
		for _, id := range []string{r.ProjectID, r.EnvironmentID, r.ServiceID} {
			if !labelPattern.MatchString(id) {
				return errors.New("请选择有效的项目、环境和服务")
			}
		}
	case "manual":
		if r.Host == "" || strings.TrimSpace(r.Host) != r.Host || strings.ContainsAny(r.Host, "/@?#:% \\\t\r\n") {
			if net.ParseIP(r.Host) == nil {
				return errors.New("后端地址只填写主机名或 IP，协议和端口单独设置")
			}
		}
		if net.ParseIP(r.Host) == nil {
			for _, part := range strings.Split(r.Host, ".") {
				if !labelPattern.MatchString(part) {
					return errors.New("无效的后端主机名")
				}
			}
		}
	default:
		return errors.New("请选择后端来源")
	}
	return nil
}
func (r Rule) Target(domain string) *url.URL {
	host := r.Host
	if r.Source == "zeabur" {
		host = "service-" + r.ServiceID + ".environment-" + r.EnvironmentID + ".svc." + domain
	}
	return &url.URL{Scheme: r.Protocol, Host: net.JoinHostPort(host, strconv.Itoa(r.Port))}
}

type Store struct{ db *sql.DB }

var ErrConflict = errors.New("规则已被修改，请刷新后重试")

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
		return r, fmt.Errorf("名称已被使用或规则无法保存: %w", err)
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
