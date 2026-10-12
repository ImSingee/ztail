# ztail

[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md)

通过 Web 面板，手动将 Zeabur Dedicated Server / k3s 中的 Web 或 TCP 服务发布到 Tailscale 网络。Web 服务获得独立的 HTTPS 地址，例如 `https://grafana.<tailnet>.ts.net`；TCP 服务使用独立的主机名和端口，例如 `redis.<tailnet>.ts.net:6379`。

支持 HTTP/HTTPS 后端、WebSocket、SSE、上传，以及数据库等服务的原始 TCP 转发。你可以选择发布哪些服务、使用什么名称；服务目录刷新不会自动发布。访问设备需要加入同一 tailnet 并获得访问权限。

## 界面语言

面板支持英文、简体中文和繁体中文。首次打开时，中文系统使用对应的中文（台湾、香港、澳门或 `zh-Hant` 使用繁体，其他中文或 `zh-Hans` 使用简体），其他系统默认英文。可在登录页或导航栏切换语言；选择保存在浏览器的 `localStorage`（`ztail.locale`）中，刷新后继续使用。语言切换保留登录状态和未保存的表单。

## 部署

### Zeabur

导入 [zeabur_template.yaml](zeabur_template.yaml)，部署到服务所在的 Dedicated Server，填写 Zeabur API Key、Server ID 和管理面板域名。

部署后，通过管理面板域名登录。`ADMIN_PASSWORD` 由模板随机生成，可在服务的使用说明中查看。

### Docker

先在当前 shell 中设置 `ADMIN_PASSWORD`、`ZEABUR_API_KEY` 和 `ZEABUR_SERVER_ID`，再启动：

```sh
docker run -d --name ztail --restart unless-stopped \
  -p 8080:8080 -v ztail-data:/data \
  -e ADMIN_PASSWORD -e ZEABUR_API_KEY -e ZEABUR_SERVER_ID \
  -e TAILSCALE_API_KEY \
  ghcr.io/imsingee/ztail:latest
```

访问 `http://localhost:8080`。容器必须能解析并访问目标集群的 Service 地址；运行在集群外时，可在面板中手填容器能访问的后端地址。

### Kubernetes

参考 [deploy/kubernetes.yaml](deploy/kubernetes.yaml)。先创建 `ztail` namespace 和 `ztail-config` Secret，Secret 中包含下表的必填变量；再应用清单，通过 HTTPS Ingress 访问管理面板。可选的 `TAILSCALE_API_KEY` 也可加入该 Secret；自定义节点 tag 时修改 Deployment 的 `TAILSCALE_TAG`。

**保留 `/data` 数据卷并使用单副本。** 它保存发布配置和节点身份，重启后可恢复连接。不同部署使用独立数据卷；自行挂载的目录需允许容器用户 `10001:10001` 写入。

## 环境变量

| 环境变量            | 要求 / 默认值   | 说明                                                        |
| ------------------- | --------------- | ----------------------------------------------------------- |
| `ADMIN_PASSWORD`    | 必填            | 管理面板密码                                                |
| `ZEABUR_API_KEY`    | 必填            | Zeabur API Key                                              |
| `ZEABUR_SERVER_ID`  | 必填            | 服务所在的 Dedicated Server ID，以 `server-` 开头           |
| `TAILSCALE_API_KEY` | 可选            | 用于创建和检查 Tailscale Service；不是节点授权用的 Auth Key |
| `TAILSCALE_TAG`     | `ztail`         | 节点 tag 名称，只填名称，不带 `tag:`                        |
| `CLUSTER_DOMAIN`    | `cluster.local` | 集群 DNS 后缀                                               |
| `PORT`              | `8080`          | 管理面板端口                                                |
| `DATA_DIR`          | `/data`         | 持久化数据目录                                              |

密码和 API Key 通过部署环境变量配置，不能在面板中修改。

## 首次设置

1. 在 Tailscale 控制台开启 MagicDNS 和 HTTPS。
2. 登录 ztail，打开「连接设置」，按页面指南配置节点 tag、Service 主机自动审批和访问授权。**将提供的条目合并到现有策略，保留其他规则，不要覆盖完整策略。**
3. 保存策略后，再选择「交互式授权」或「使用 Auth Key 加入」，等待节点显示「已连接」。Auth Key 是 `tskey-auth-` 开头的节点授权密钥，不能用 API Key 代替。

连接后，也可通过「连接设置」中显示的 tailnet 管理面板地址访问 ztail，仍需输入管理员密码。

### Service 定义

- **配置了 `TAILSCALE_API_KEY`：** 发布时可勾选通过 API 创建尚未定义的 Service。API Key 需具有对应 tailnet 的 Service 管理权限。
- **未配置 `TAILSCALE_API_KEY`：** 先在 Tailscale 控制台定义同名 Service。例如发布名称为 `grafana`，控制台的 Service name 填 `grafana`，端口设置为 TCP 443，Service tag 选择 `tag:ztail-service`。

节点默认使用 `tag:ztail`，Service 使用 `tag:ztail-service`。自定义节点 tag 后，按面板显示的策略片段配置。TCP 服务的 Service 端口填写所选发布端口，例如 Redis 使用 `tcp:6379`；访问策略也需允许该端口。每条规则仅发布一个端口；已有 Service 定义不会被覆盖，修改发布端口时需先在控制台调整定义，或使用新的服务名称。

## 发布服务

1. 在「Zeabur 服务」中找到项目和环境，点击目标 HTTP/HTTPS 或 TCP 端口的「发布」。也可在「已发布」中点击「发布」，手填后端地址。
2. 确认访问名称与后端端口，发布到 tailnet。需要更多配置时可进入完整编辑页，测试后端或保存草稿。
3. 在「已发布」中查看访问地址、发布状态和后端连接结果，也可编辑、停用或删除服务。

TCP 发布端口默认与后端端口相同，可单独设置。使用数据库等对应客户端连接显示的 `主机名:发布端口`，例如 `redis-cli -h redis.<tailnet>.ts.net -p 6379`，而不是用浏览器打开。TCP 数据原样转发（包括后端自己的 TLS 协商），无需 Tailscale HTTPS 证书。TCP 后端测试只验证端口能够建立连接，不验证登录或应用协议。修改后端地址仅影响新 TCP 连接；修改协议或发布端口、停用或删除服务会关闭现有 TCP 连接。

停用或删除服务只撤回当前节点的发布，保留 Tailscale 控制台中的 Service 定义。

## 常见问题

- **节点授权提示 tag 无效或不允许：** 先按「连接设置」的指南配置 `tagOwners`，确认授权账号有权使用该节点 tag，再重新授权。
- **Service 未定义或对节点不可见：** 检查 Service 名称、发布端口（Web 为 `tcp:443`）、`tag:ztail-service` 和访问策略。点击错误中的「配置访问策略」可查看当前服务的配置指南。
- **名称与已有节点冲突：** 改用其他发布名称。例如节点已经叫 `ztail`，Service 可命名为 `ztail-web`。
- **已发布但无法访问：** 「已发布」不代表主机已获审批。确认 Services 控制台中的 Service hosts 已批准 ztail 节点，以及客户端具有访问权限。自动审批策略匹配时会自动批准；否则需手动审批。首次 HTTPS 证书签发可能需要数分钟，刚发布请稍候重试；页面上的「无法访问已发布的服务？」提供相关说明。
- **后端不可达：** 检查所选环境、端口、服务运行状态及集群 DNS/网络。HTTPS 后端需提供有效证书；限制 Host 的应用需允许发布后的 tailnet 域名。
- **UDP 服务：** 暂不支持 UDP 发布，目录中的 UDP 端口仅供参考。

## License

MIT
