package ztail

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type NamedID struct {
	ID   string `json:"_id"`
	Name string `json:"name"`
}
type Service struct {
	NamedID
	DNSName      string                        `json:"dnsName"`
	Environments map[string]ServiceEnvironment `json:"environments"`
}
type ServicePort struct {
	ID   string `json:"id"`
	Port int    `json:"port"`
	Type string `json:"type"`
}
type ServiceEnvironment struct {
	Status string        `json:"status"`
	Ports  []ServicePort `json:"ports"`
	Error  string        `json:"error"`
}
type Project struct {
	NamedID
	Environments []NamedID `json:"environments"`
	Services     []Service `json:"services"`
	Region       struct {
		ID string `json:"id"`
	} `json:"region"`
}
type Catalog struct {
	Server    NamedID   `json:"server"`
	Projects  []Project `json:"projects"`
	UpdatedAt string    `json:"updatedAt"`
	Error     string    `json:"error"`
}
type CatalogProvider interface {
	Catalog() Catalog
	Refresh(context.Context) error
	Contains(Rule) bool
}
type Zeabur struct {
	mu                      sync.RWMutex
	refreshMu               sync.Mutex
	key, serverID, endpoint string
	client                  *http.Client
	catalog                 Catalog
}

func NewZeabur(c Config) *Zeabur {
	return &Zeabur{key: c.ZeaburKey, serverID: c.ServerID, endpoint: "https://api.zeabur.com/graphql", client: &http.Client{Timeout: 20 * time.Second}, catalog: Catalog{Server: NamedID{ID: c.ServerID}, Projects: []Project{}}}
}
func (z *Zeabur) Catalog() Catalog { z.mu.RLock(); defer z.mu.RUnlock(); return z.catalog }
func (z *Zeabur) Contains(r Rule) bool {
	cat := z.Catalog()
	for _, p := range cat.Projects {
		if p.ID != r.ProjectID {
			continue
		}
		env, svc := false, false
		for _, e := range p.Environments {
			env = env || e.ID == r.EnvironmentID
		}
		for _, s := range p.Services {
			svc = svc || s.ID == r.ServiceID
		}
		return env && svc
	}
	return false
}
func (z *Zeabur) Refresh(ctx context.Context) (err error) {
	z.refreshMu.Lock()
	defer z.refreshMu.Unlock()
	defer func() {
		if err != nil {
			z.mu.Lock()
			z.catalog.Error = strings.ReplaceAll(err.Error(), z.key, "[redacted]")
			z.mu.Unlock()
		}
	}()
	type graphQLResponse struct {
		Data struct {
			Servers  []NamedID `json:"servers"`
			Projects struct {
				Edges []struct {
					Node Project `json:"node"`
				} `json:"edges"`
				PageInfo struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
			} `json:"projects"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	cat := Catalog{Projects: []Project{}}
	seen := map[string]bool{}
	skip := 0
	for page := 0; page < 100; page++ {
		var result graphQLResponse
		body, _ := json.Marshal(map[string]any{"query": `query($skip: Int!) { servers { _id name } projects(skip: $skip, limit: 1024) { edges { node { _id name environments { _id name } services { _id name dnsName } region { id } } } pageInfo { hasNextPage } } }`, "variables": map[string]int{"skip": skip}})
		req, e := http.NewRequestWithContext(ctx, "POST", z.endpoint, bytes.NewReader(body))
		if e != nil {
			return e
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+z.key)
		resp, e := z.client.Do(req)
		if e != nil {
			return errors.New("Zeabur API 无法连接，请检查网络后重试")
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return fmt.Errorf("Zeabur API 返回 HTTP %d，请检查 API Key 和账号权限", resp.StatusCode)
		}
		e = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&result)
		resp.Body.Close()
		if e != nil {
			return errors.New("Zeabur API 返回无效数据")
		}
		if len(result.Errors) > 0 {
			return fmt.Errorf("Zeabur GraphQL: %s", result.Errors[0].Message)
		}
		if page == 0 {
			for _, server := range result.Data.Servers {
				if "server-"+server.ID == z.serverID || server.ID == z.serverID {
					cat.Server = server
					cat.Server.ID = z.serverID
					break
				}
			}
			if cat.Server.ID == "" {
				return errors.New("配置的 ZEABUR_SERVER_ID 不存在或当前账号无权访问")
			}
		}
		added := 0
		for _, edge := range result.Data.Projects.Edges {
			if seen[edge.Node.ID] {
				continue
			}
			seen[edge.Node.ID] = true
			added++
			if edge.Node.Region.ID == z.serverID {
				cat.Projects = append(cat.Projects, edge.Node)
			}
		}
		if !result.Data.Projects.PageInfo.HasNextPage {
			z.loadServiceEnvironments(ctx, &cat)
			cat.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			z.mu.Lock()
			z.catalog = cat
			z.mu.Unlock()
			return nil
		}
		if added == 0 {
			return errors.New("Zeabur API 分页未推进，保留上一次完整目录")
		}
		skip += len(result.Data.Projects.Edges)
	}
	return errors.New("Zeabur 目录超过查询安全上限，保留上一次完整目录")
}

// Ports and deployment status are environment-scoped in Zeabur. Batch aliases
// keep catalogue refresh bounded without interpolating resource IDs into GraphQL.
func (z *Zeabur) loadServiceEnvironments(ctx context.Context, cat *Catalog) {
	type lookup struct {
		project, service int
		environment      string
	}
	var lookups []lookup
	previous := z.Catalog()
	cachedDetails := map[string]ServiceEnvironment{}
	for _, p := range previous.Projects {
		for _, s := range p.Services {
			for env, detail := range s.Environments {
				cachedDetails[p.ID+"/"+s.ID+"/"+env] = detail
			}
		}
	}
	for pi := range cat.Projects {
		p := &cat.Projects[pi]
		for si := range p.Services {
			p.Services[si].Environments = map[string]ServiceEnvironment{}
			for _, env := range p.Environments {
				lookups = append(lookups, lookup{pi, si, env.ID})
			}
		}
	}
	failed := 0
	for start := 0; start < len(lookups); start += 32 {
		end := min(start+32, len(lookups))
		batch := lookups[start:end]
		definitions, fields := []string{}, []string{}
		variables := map[string]string{}
		for i, item := range batch {
			definitions = append(definitions, fmt.Sprintf("$s%d: ObjectID!, $e%d: ObjectID!", i, i))
			fields = append(fields, fmt.Sprintf("s%d: service(_id: $s%d) { status(environmentID: $e%d) ports(environmentID: $e%d) { id port type } }", i, i, i, i))
			variables[fmt.Sprintf("s%d", i)] = cat.Projects[item.project].Services[item.service].ID
			variables[fmt.Sprintf("e%d", i)] = item.environment
		}
		var result struct {
			Data   map[string]*ServiceEnvironment `json:"data"`
			Errors []struct {
				Message string `json:"message"`
				Path    []any  `json:"path"`
			} `json:"errors"`
		}
		body, _ := json.Marshal(map[string]any{"query": "query(" + strings.Join(definitions, ",") + ") {" + strings.Join(fields, " ") + "}", "variables": variables})
		req, requestErr := http.NewRequestWithContext(ctx, "POST", z.endpoint, bytes.NewReader(body))
		if requestErr != nil {
			cat.Error = "服务详情请求地址无效"
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+z.key)
		batchError := ""
		resp, err := z.client.Do(req)
		if err != nil {
			batchError = "服务详情无法连接，请刷新重试"
		} else {
			if resp.StatusCode != 200 {
				batchError = fmt.Sprintf("服务详情返回 HTTP %d，请检查 API Key 和账号权限", resp.StatusCode)
			} else if json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&result) != nil {
				batchError = "服务详情返回无效数据"
			}
			resp.Body.Close()
		}
		aliasErrors := map[string]string{}
		for _, e := range result.Errors {
			message := strings.ReplaceAll(e.Message, z.key, "[redacted]")
			if len(e.Path) > 0 {
				if alias, ok := e.Path[0].(string); ok {
					aliasErrors[alias] = message
					continue
				}
			}
			batchError = message
		}
		for i, item := range batch {
			svc := &cat.Projects[item.project].Services[item.service]
			alias := fmt.Sprintf("s%d", i)
			detail, message := result.Data[alias], batchError
			if e := aliasErrors[alias]; e != "" {
				message = e
			}
			if detail == nil && message == "" {
				message = "服务详情暂不可用，请刷新重试"
			}
			if message != "" {
				failed++
				cached := ServiceEnvironment{Ports: []ServicePort{}}
				if old, ok := cachedDetails[cat.Projects[item.project].ID+"/"+svc.ID+"/"+item.environment]; ok {
					cached = old
				}
				cached.Error = message
				svc.Environments[item.environment] = cached
			} else {
				if detail.Ports == nil {
					detail.Ports = []ServicePort{}
				}
				svc.Environments[item.environment] = *detail
			}
		}
	}
	if failed > 0 {
		cat.Error = fmt.Sprintf("%d 个服务环境的详情读取失败，已保留上次可用数据。刷新可重试。", failed)
	}
}
