# ztail

**English** | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Manually publish Web or TCP services from a Zeabur Dedicated Server / k3s cluster to your Tailscale network through a web console. Each Web service gets its own HTTPS address, such as `https://grafana.<tailnet>.ts.net`. TCP services use their own hostname and port, such as `redis.<tailnet>.ts.net:6379`.

Supports HTTP/HTTPS backends, WebSocket, SSE, uploads, and raw TCP forwarding for services such as databases. You choose which services to publish and their names; refreshing the catalog does not publish anything automatically. Client devices must join the same tailnet and have access permission.

## Interface languages

The console supports English, Simplified Chinese and Traditional Chinese. On first visit, Chinese system languages select the corresponding Chinese variant: Taiwan, Hong Kong, Macao or `zh-Hant` use Traditional Chinese; other Chinese locales or `zh-Hans` use Simplified Chinese. Other system languages default to English. Switch languages on the sign-in page or in the navigation bar. Your choice is saved in browser `localStorage` (`ztail.locale`) and restored on reload. Switching languages preserves your session and unsaved forms.

## Deployment

### Zeabur

Import [zeabur_template.yaml](zeabur_template.yaml), deploy to the Dedicated Server hosting your services, and enter the Zeabur API Key, Server ID and console domain.

After deployment, sign in through the console domain. The template generates `ADMIN_PASSWORD` randomly; find it in the service's usage instructions.

### Docker

Set `ADMIN_PASSWORD`, `ZEABUR_API_KEY` and `ZEABUR_SERVER_ID` in your current shell, then run:

```sh
docker run -d --name ztail --restart unless-stopped \
  -p 8080:8080 -v ztail-data:/data \
  -e ADMIN_PASSWORD -e ZEABUR_API_KEY -e ZEABUR_SERVER_ID \
  -e TAILSCALE_API_KEY \
  ghcr.io/imsingee/ztail:latest
```

Open `http://localhost:8080`. The container must resolve and reach the target cluster's Service addresses. When running outside the cluster, enter a backend address reachable from the container in the console.

### Kubernetes

See [deploy/kubernetes.yaml](deploy/kubernetes.yaml). Create the `ztail` namespace and a `ztail-config` Secret containing the required variables below, then apply the manifest and access the console through an HTTPS Ingress. You can add the optional `TAILSCALE_API_KEY` to the same Secret. To customize the node tag, change `TAILSCALE_TAG` in the Deployment.

**Keep the `/data` volume and use a single replica.** It stores publishing configuration and node identity so connections can be restored after restart. Use a separate volume for each deployment. Mounted directories must be writable by container user `10001:10001`.

## Environment variables

| Variable            | Requirement / Default | Description                                                                             |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`    | Required              | Console password                                                                        |
| `ZEABUR_API_KEY`    | Required              | Zeabur API Key                                                                          |
| `ZEABUR_SERVER_ID`  | Required              | Dedicated Server ID hosting the services, starting with `server-`                       |
| `TAILSCALE_API_KEY` | Optional              | Creates and checks Tailscale Services; this is not the Auth Key used to enroll the node |
| `TAILSCALE_TAG`     | `ztail`               | Node tag name, without the `tag:` prefix                                                |
| `CLUSTER_DOMAIN`    | `cluster.local`       | Cluster DNS suffix                                                                      |
| `PORT`              | `8080`                | Console port                                                                            |
| `DATA_DIR`          | `/data`               | Persistent data directory                                                               |

Configure passwords and API Keys through deployment environment variables. They cannot be changed in the console.

## Initial setup

1. Enable MagicDNS and HTTPS in the Tailscale console.
2. Sign in to ztail and open **Connection settings**. Follow the guide to configure the node tag, automatic Service host approval and access permissions. **Merge the provided entries into your existing policy, keeping other rules. Do not replace the entire policy.**
3. Save the policy, then choose **Interactive authorization** or **Join with an Auth Key** and wait for **Connected**. An Auth Key is a node enrollment key starting with `tskey-auth-`; an API Key cannot replace it.

Once connected, you can also access ztail through the tailnet console address shown in **Connection settings**. The admin password is still required.

### Service definitions

- **With `TAILSCALE_API_KEY`:** When publishing, enable API creation of an undefined Service. The API Key needs Service management permissions for the corresponding tailnet.
- **Without `TAILSCALE_API_KEY`:** First define a Service with the same name in the Tailscale console. For example, to publish `grafana`, enter `grafana` as the Service name, set the port to TCP 443 and select Service tag `tag:ztail-service`.

The node uses `tag:ztail` by default; Services use `tag:ztail-service`. If you customize the node tag, follow the policy fragment shown in the console. For a TCP Service, define the chosen published port, such as `tcp:6379` for Redis, and allow it in the access policy. Each rule publishes one port. Existing Service definitions are never overwritten: when changing the published port, first update its definition in the Tailscale console or use a new service name.

## Publishing services

1. Find the project and environment under **Zeabur services**, then click **Publish** for the desired HTTP/HTTPS or TCP port. You can also click **Publish** under **Published** and enter a backend address manually.
2. Confirm the access name and backend port, then publish to your tailnet. Open the full editor to test the backend, adjust more settings or save a draft.
3. Under **Published**, inspect the address, publishing status and backend connectivity. You can also edit, disable or delete services.

The TCP published port defaults to the backend port and can be set independently. Connect to the displayed `hostname:published-port` using the appropriate client, such as `redis-cli -h redis.<tailnet>.ts.net -p 6379`. TCP data is forwarded unchanged, including the backend's own TLS handshake; no Tailscale HTTPS certificate is needed. A TCP backend test only checks that a connection can be established, not authentication or the application protocol. Changing the backend address affects only new TCP connections. Changing the protocol or published port, disabling or deleting a service closes its existing TCP connections.

Disabling or deleting a service withdraws only this node's advertisement. The Service definition in the Tailscale console remains.

## Troubleshooting

- **Node authorization reports an invalid or disallowed tag:** Configure `tagOwners` using the **Connection settings** guide, ensure the authorizing account can use the node tag, then authorize again.
- **Service undefined or invisible to the node:** Check its name, published port (`tcp:443` for Web), `tag:ztail-service` and access policy. Click **Configure access policy** in the error to open the guide for this service.
- **Name conflicts with an existing node:** Choose another publishing name. If a node is already named `ztail`, name the Service `ztail-web`, for example.
- **Published but inaccessible:** **Published** does not mean the host is approved. Check that Service hosts in the Services console has approved the ztail node and the client has access permission. Matching automatic approval policies approve hosts automatically; otherwise, approve manually. Initial HTTPS certificate issuance may take several minutes. Wait and retry if you just published. **Can't access a published service?** explains these checks.
- **Backend unreachable:** Check the selected environment, port, service status and cluster DNS/network. HTTPS backends must present a valid certificate. Applications that restrict the Host header must allow the published tailnet hostname.
- **UDP services:** UDP publishing is currently unsupported. UDP ports in the catalog are shown for reference only.

## License

MIT
