package ztail

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Config struct {
	Password, ZeaburKey, ServerID, TailscaleKey, Tag, ClusterDomain, Port, DataDir string
}

var labelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var tagPattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]*$`)

func LoadConfig() (Config, error) {
	c := Config{Password: os.Getenv("ADMIN_PASSWORD"), ZeaburKey: os.Getenv("ZEABUR_API_KEY"), ServerID: os.Getenv("ZEABUR_SERVER_ID"), TailscaleKey: os.Getenv("TAILSCALE_API_KEY"), Tag: env("TAILSCALE_TAG", "ztail"), ClusterDomain: env("CLUSTER_DOMAIN", "cluster.local"), Port: env("PORT", "8080"), DataDir: env("DATA_DIR", "/data")}
	for _, v := range []struct{ name, value string }{{"ADMIN_PASSWORD", c.Password}, {"ZEABUR_API_KEY", c.ZeaburKey}, {"ZEABUR_SERVER_ID", c.ServerID}} {
		if strings.TrimSpace(v.value) == "" {
			return c, fmt.Errorf("missing required environment variable %s", v.name)
		}
	}
	if !strings.HasPrefix(c.ServerID, "server-") || len(c.ServerID) <= 7 {
		return c, fmt.Errorf("ZEABUR_SERVER_ID must start with server-")
	}
	if !tagPattern.MatchString(c.Tag) {
		return c, fmt.Errorf("TAILSCALE_TAG must be a bare tag name, for example ztail")
	}
	for _, part := range strings.Split(c.ClusterDomain, ".") {
		if !labelPattern.MatchString(part) {
			return c, fmt.Errorf("invalid CLUSTER_DOMAIN")
		}
	}
	p, err := strconv.Atoi(c.Port)
	if err != nil || p < 1 || p > 65535 {
		return c, fmt.Errorf("invalid PORT")
	}
	return c, nil
}
func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}
func (c Config) NodeTag() string { return "tag:" + c.Tag }

// Redact removes configured and transient secrets from external error messages.
func (c Config) Redact(message string) string {
	for _, s := range []string{c.Password, c.ZeaburKey, c.TailscaleKey} {
		if s != "" {
			message = strings.ReplaceAll(message, s, "[redacted]")
		}
	}
	return message
}
