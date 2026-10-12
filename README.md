# ztail

在 Zeabur Dedicated Server 的 k3s 集群内，手动将 Web 服务发布为 Tailscale Services HTTPS 地址。

ztail 提供管理面板，从 Zeabur 目录选择项目、环境和服务，或手填集群地址。只有启用的规则才会广告，目录刷新不会自动发布服务。

首页按项目和环境列出服务名称、DNS、ID、部署状态和端口，可搜索和折叠。点击 HTTP/HTTPS 端口的「发布」，确认预填的访问名称即可发布到 tailnet；名称可修改，同一服务在不同环境可分别发布。已有规则提供管理入口。TCP/UDP 和缺失端口可查看并进入完整配置，不自动推断为 Web 服务。

```text
tailnet 设备 → https://grafana.<tailnet>.ts.net
            → ztail（tsnet / HTTPS）→ 集群 Service:端口

Zeabur HTTPS 域名 → 管理面板（管理员密码）
```

## 配置

| 环境变量 | 要求 / 默认值 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 必填 | 管理面板密码；Zeabur 模板随机生成 |
| `ZEABUR_API_KEY` | 必填 | Zeabur API Key |
| `ZEABUR_SERVER_ID` | 必填 | 部署所在 Dedicated Server，`server-` 开头；面板不可切换 |
| `TAILSCALE_API_KEY` | 可选 | Tailscale API Access Token；用于创建/检查 Service 定义，不是节点 Auth Key |
| `TAILSCALE_TAG` | `ztail` | 只填名称，内部自动添加 `tag:`，例如 `custom-host` → `tag:custom-host` |
| `CLUSTER_DOMAIN` | `cluster.local` | k3s DNS 后缀 |
| `PORT` | `8080` | 管理面板端口 |
| `DATA_DIR` | `/data` | SQLite 配置、撤回队列和 Tailscale 节点状态 |

密码和两个 API Key 由环境变量提供，面板不编辑、不保存它们。不支持旧名称 `AUTH_PASSWORD`。

## 部署

### Zeabur

使用 [zeabur_template.yaml](zeabur_template.yaml) 创建模板，部署到 `ZEABUR_SERVER_ID` 指定的 Dedicated Server。模板绑定管理面板 HTTPS 域名，并挂载 `/data`。

镜像由 GitHub Actions 发布到 `ghcr.io/imsingee/ztail`。首次使用前，确认构建任务成功且镜像包可公开拉取。模板文件尚未注册公共模板编号。

登录后在「连接设置」中通过 **交互式授权** 或 **Auth Key** 加入 tailnet。Auth Key 接入成功后不持久化；节点重启依靠 `/data/tailscale` 中的身份恢复。

### Kubernetes

创建 namespace 和 Secret，再应用 [deploy/kubernetes.yaml](deploy/kubernetes.yaml)：

```sh
kubectl create namespace ztail
# 先在当前 shell 中设置这些环境变量，不要将真实凭据提交到仓库。
kubectl -n ztail create secret generic ztail-config \
  --from-literal=ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  --from-literal=ZEABUR_API_KEY="$ZEABUR_API_KEY" \
  --from-literal=ZEABUR_SERVER_ID="$ZEABUR_SERVER_ID"
kubectl apply -f deploy/kubernetes.yaml
```

通过你的 HTTPS Ingress 公开管理面板的 Service。可选 `TAILSCALE_API_KEY` 加入同一个 Secret。自定义节点 tag 修改 Deployment 的 `TAILSCALE_TAG`。容器使用 UID/GID 10001，卷需可写；不需要 ServiceAccount 权限、hostNetwork、TUN 或特权容器。使用 Recreate 策略和单副本，避免两个实例共享同一节点身份。

### 本地构建 / Docker

需要 Go 1.27.1+、Node.js 24 和 pnpm 10.32.1：

```sh
make build
# 按上表设置环境变量；本地使用可写的数据目录。
DATA_DIR=./data ./ztail
```

```sh
docker build -t ztail:local .
docker run --rm -p 8080:8080 -v ztail-data:/data \
  -e ADMIN_PASSWORD -e ZEABUR_API_KEY -e ZEABUR_SERVER_ID \
  -e TAILSCALE_API_KEY -e TAILSCALE_TAG=ztail ztail:local
```

访问 `http://localhost:8080`。本地只能连接当前容器/主机能访问的后端；k3s Service DNS 需要在对应集群内解析。

## Tailscale 设置

在 Tailscale 控制台开启 MagicDNS 和 HTTPS，为节点允许配置的 tag。节点必须实际获得 tag 才能作为 Service host。

面板提供下列规则的合并示例（自定义节点 tag 会自动体现在示例中）：

```json
{
  "tagOwners": {
    "tag:ztail": ["autogroup:admin"],
    "tag:ztail-service": ["autogroup:admin"]
  },
  "autoApprovers": {
    "services": { "tag:ztail-service": ["tag:ztail"] }
  },
  "grants": [
    {
      "src": ["autogroup:member", "tag:ztail"],
      "dst": ["tag:ztail-service"],
      "ip": ["tcp:443"]
    }
  ]
}
```

这是合并片段，不应替换已有的完整策略。访问来源按你的团队需求调整；保留节点 tag 的读取/访问权限，供无 API Key 模式核验可见 Service。ztail 不修改全局策略，也不提供 OAuth。

### 不配置 Tailscale API Key

先在控制台定义 `svc:grafana`，端口 `tcp:443`，赋予 `tag:ztail-service`。然后在 ztail 中配置同名规则并发布。ztail 通过节点本地 API 读取可见 Service；未找到时可能是尚未定义，也可能是访问策略没有允许该节点看到它。

### 配置可选 API Key

设置 `TAILSCALE_API_KEY`，重启 ztail，在编辑规则时勾选「名称尚未定义时，通过 API 创建 Service」。API Key 必须能访问节点所加入的 tailnet，具有 Service 管理权限。程序先 GET 检查定义，只有 404 且明确启用创建时才 PUT 新定义，不覆盖已有 Service。

节点加入、Service 定义、主机审批和访问授权是独立步骤。详情见 [Tailscale Services](https://tailscale.com/docs/features/tailscale-services)。

## 发布规则

1. 选择 Zeabur 项目、**明确选择环境**与服务，填写后端协议和端口；或直接填写后端主机名/IP。
2. 设置小写 Service 名称，预览完整 `https://名称.<tailnet>.ts.net` 地址。
3. 可先测试后端连接，保存草稿，或保存并发布。

Zeabur 后端使用 `service-<serviceID>.environment-<environmentID>.svc.<clusterDomain>:<port>`。服务必须实际部署在所选环境中；API 目录本身不代表运行状态。目录每五分钟刷新，错误保留上一次结果。

端口与部署状态通过 Zeabur 的 `ports(environmentID:)` / `status(environmentID:)` 按环境读取，并批量查询。详情失败时保留该环境的上次数据和错误，快捷发布暂停，其他环境仍可操作。快捷发布默认从服务 DNS 名生成访问名称，冲突时添加数字后缀；确认前不会创建规则。配置了 API Key 时，可在行内表单选择创建缺少的 Tailscale Service 定义。

修改后端保留监听入口；改名先建立新入口，失败时保留旧入口。停用/删除只撤回本节点广告，保留远端 Service 定义。撤回失败持久化并自动重试；连接设置页也展示已删除规则遗留的撤回错误。重启会清理本节点遗留广告，再恢复启用规则。

遇到「Service 未定义或对本节点不可见」时，点击错误中的「配置访问策略」打开当前服务指南。弹窗提供可复制的 Service name、HTTPS 443 端口、Service tag 和审批/访问策略片段，并链接到 Tailscale 控制台。配置保存后可从弹窗重试发布；指南不会代替你修改 tailnet 策略。

“已广告”只表示本地声明承载 Service，审批状态未知时请以控制台为准。后端“可达”表示 HTTP/TLS 握手获得响应，不代表应用健康或所有 tailnet 用户均有访问权限。若后端使用自身证书，HTTPS 模式默认校验证书。

支持 WebSocket、SSE 和上传。后端接收原始 Host、路径/query，以及 HTTPS 转发协议头；`X-Forwarded-For` 由代理生成，来自请求的伪造值不会直接转发。应用若限制 Host，需允许发布后的 tailnet 域名。

## 检查与接口

```sh
pnpm --dir web build
go test -race ./...
go vet ./...
pnpm --dir web exec playwright install chromium
pnpm --dir web test:e2e
```

Playwright 启动的是独立 `_test.go` 程序：真实面板、HTTP 接口、SQLite、协调器和代理，替换 Zeabur/Tailscale 控制面。正式镜像中没有测试开关或 fixture 路由。这些测试不证明真实 tailnet 的 MagicDNS、证书或远端审批。

管理 API 使用 cookie 会话，修改请求需要 `X-CSRF-Token`，由 `GET /api/session` 读取。会话为 HttpOnly、SameSite=Strict，HTTPS 下使用 Secure cookie。密码登录仅接受 `POST /api/session`。

页面入口：`/` 为服务目录，`/rules` 为发布规则，`/rules/new` 与 `/rules/<id>` 为完整编辑，`/settings` 为连接设置。服务目录 API 中，每个服务的 `environments[environmentID]` 包含 `status`、`ports`（id/port/type）和 `error`。

| 接口 | 用途 |
| --- | --- |
| `GET /healthz` | 进程健康与构建版本；不代表外部连接已就绪 |
| `GET/POST/DELETE /api/session` | 读取会话、登录、退出 |
| `GET /api/settings` | 固定配置、策略示例、撤回错误；不返回凭据 |
| `GET /api/catalog`、`POST /api/catalog/refresh` | 读取/刷新服务目录 |
| `GET /api/tailscale`、`POST /api/tailscale/connect` | 节点状态与接入 |
| `GET/POST /api/rules`、`PUT/DELETE /api/rules/{id}` | 规则管理；更新携带 revision，防止覆盖并发修改 |
| `POST /api/rules/{id}/retry` | 排队重试协调 |
| `POST /api/probe` | 后端连接检测 |

接口返回配置保存结果，应用状态随后从规则列表查询。撤回和发布通过串行协调流程处理。

## 边界与排查

- 首版只发布 HTTP/HTTPS Web 服务，前端固定 HTTPS 443；不包含 TCP 数据库代理、路径分流、Funnel、自定义公网域名或多 tailnet。
- 节点缺少 tag：检查 tagOwners、授权账号以及实际节点 tag。
- Service 未定义/不可见：检查名称、`tcp:443`、Service tag 和访问策略。
- Service 名称与已有节点名称冲突：修改发布规则的 Service 名称。例如节点已使用 `ztail.<tailnet>.ts.net` 时，可将 Service 命名为 `ztail-web`；节点与 Service 不能占用同一个访问名称。
- 已广告但无法访问：检查控制台主机审批、访问授权、MagicDNS/HTTPS 和调用设备的 tailnet 连接。
- 后端不可达：检查环境 ID、端口、服务运行状态、集群 DNS/网络及 HTTPS 证书。
- 切换到另一个 tailnet 会停止套用旧规则；首版不提供切换功能。不同部署使用独立数据卷。

## License

MIT

Auth Key 接入是异步流程：界面会先显示正在接入，只有节点进入 `Running` 才显示已连接；需要设备审批时会提供节点管理入口。无效 Key 等控制面错误、健康警告及超过 90 秒仍未完成的提示会显示在连接设置中，日志同步记录接入与状态变化并隐藏 Key。超时提示不会终止 SDK 的后台重试。Auth Key 必须是 `tskey-auth-`，API Key 不用于节点登录。

连接设置先展示服务器信息，再按「合并并保存策略 → 授权节点」排列，策略片段默认展开，明确保留已有策略。交互式授权持续等待本次 URL，链接就绪后直接打开授权页；浏览器拦截时提供手动打开链接。失败、超时或离页会取消等待，不会打开中间等待页。已连接时优先展示节点状态，策略保留为可展开的配置参考。

授权进度按当前使用的方式展示：Auth Key 按钮持续等待节点接入，交互式授权在获取链接后显示等待网页授权完成。只有节点进入已连接或待审批、明确失败/超时后才结束等待，并立即更新状态。页面只隐藏未接受其他节点子网路由的已知提示；网络、登录等其他健康问题仍显示，原始健康状态和日志保留。
