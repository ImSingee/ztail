# ztail

[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文**

透過 Web 面板，手動將 Zeabur Dedicated Server / k3s 中的 Web 或 TCP 服務發佈到 Tailscale 網路。Web 服務獲得獨立的 HTTPS 位址，例如 `https://grafana.<tailnet>.ts.net`；TCP 服務使用獨立的主機名稱和連接埠，例如 `redis.<tailnet>.ts.net:6379`。

支援 HTTP/HTTPS 後端、WebSocket、SSE、上傳，以及資料庫等服務的原始 TCP 轉發。你可以選擇發佈哪些服務、使用什麼名稱；服務目錄重新整理不會自動發佈。存取裝置需要加入同一 tailnet 並獲得存取權限。

## 介面語言

面板支援英文、簡體中文和繁體中文。首次開啟時，中文系統使用對應的中文（臺灣、香港、澳門或 `zh-Hant` 使用繁體，其他中文或 `zh-Hans` 使用簡體），其他系統預設英文。可在登入頁或導航欄切換語言；選擇儲存在瀏覽器的 `localStorage`（`ztail.locale`）中，重新整理後繼續使用。語言切換保留登入狀態和未儲存的表單。

## 部署

### Zeabur

匯入 [zeabur_template.yaml](zeabur_template.yaml)，部署到服務所在的 Dedicated Server，填寫 Zeabur API Key、Server ID 和管理面板域名。

部署後，透過管理面板域名登入。`ADMIN_PASSWORD` 由模板隨機生成，可在服務的使用說明中檢視。

### Docker

先在當前 shell 中設定 `ADMIN_PASSWORD`、`ZEABUR_API_KEY` 和 `ZEABUR_SERVER_ID`，再啟動：

```sh
docker run -d --name ztail --restart unless-stopped \
  -p 8080:8080 -v ztail-data:/data \
  -e ADMIN_PASSWORD -e ZEABUR_API_KEY -e ZEABUR_SERVER_ID \
  -e TAILSCALE_API_KEY \
  ghcr.io/imsingee/ztail:latest
```

存取 `http://localhost:8080`。容器必須能解析並存取目標叢集的 Service 地址；執行在叢集外時，可在面板中手填容器能存取的後端位址。

### Kubernetes

參考 [deploy/kubernetes.yaml](deploy/kubernetes.yaml)。先建立 `ztail` namespace 和 `ztail-config` Secret，Secret 中包含下表的必填變數；再應用清單，透過 HTTPS Ingress 存取管理面板。可選的 `TAILSCALE_API_KEY` 也可加入該 Secret；自定義節點 tag 時修改 Deployment 的 `TAILSCALE_TAG`。

**保留 `/data` 資料卷並使用單副本。** 它儲存發佈設定和節點身份，重啟後可恢復連線。不同部署使用獨立資料卷；自行掛載的目錄需允許容器使用者 `10001:10001` 寫入。

## 環境變數

| 環境變數            | 要求 / 預設值   | 說明                                                        |
| ------------------- | --------------- | ----------------------------------------------------------- |
| `ADMIN_PASSWORD`    | 必填            | 管理面板密碼                                                |
| `ZEABUR_API_KEY`    | 必填            | Zeabur API Key                                              |
| `ZEABUR_SERVER_ID`  | 必填            | 服務所在的 Dedicated Server ID，以 `server-` 開頭           |
| `TAILSCALE_API_KEY` | 可選            | 用於建立和檢查 Tailscale Service；不是節點授權用的 Auth Key |
| `TAILSCALE_TAG`     | `ztail`         | 節點 tag 名稱，只填名稱，不帶 `tag:`                        |
| `CLUSTER_DOMAIN`    | `cluster.local` | 叢集 DNS 後綴                                               |
| `PORT`              | `8080`          | 管理面板連接埠                                              |
| `DATA_DIR`          | `/data`         | 持久化資料目錄                                              |

密碼和 API Key 透過部署環境變數設定，不能在面板中修改。

## 首次設定

1. 在 Tailscale 控制台開啟 MagicDNS 和 HTTPS。
2. 登入 ztail，開啟「連線設定」，按頁面指南設定節點 tag、Service 主機自動審批和存取授權。**將提供的項目合併到現有策略，保留其他規則，不要覆蓋完整策略。**
3. 儲存策略後，再選擇「互動式授權」或「使用 Auth Key 加入」，等待節點顯示「已連線」。Auth Key 是 `tskey-auth-` 開頭的節點授權金鑰，不能用 API Key 代替。

連線後，也可透過「連線設定」中顯示的 tailnet 管理面板位址存取 ztail，仍需輸入管理員密碼。

### Service 定義

- **設定了 `TAILSCALE_API_KEY`：** 發佈時可勾選透過 API 建立尚未定義的 Service。API Key 需具有對應 tailnet 的 Service 管理權限。
- **未設定 `TAILSCALE_API_KEY`：** 先在 Tailscale 控制台定義同名 Service。例如發佈名稱為 `grafana`，控制台的 Service name 填 `grafana`，連接埠設定為 TCP 443，Service tag 選擇 `tag:ztail-service`。

節點預設使用 `tag:ztail`，Service 使用 `tag:ztail-service`。自定義節點 tag 後，按面板顯示的策略片段設定。TCP 服務的 Service 連接埠填寫所選發佈連接埠，例如 Redis 使用 `tcp:6379`；存取策略也需允許該連接埠。每條規則僅發佈一個連接埠；已有 Service 定義不會被覆蓋，修改發佈連接埠時需先在控制台調整定義，或使用新的服務名稱。

## 發佈服務

1. 在「Zeabur 服務」中找到專案和環境，點選目標 HTTP/HTTPS 或 TCP 連接埠的「發佈」。也可在「已發佈」中點選「發佈」，手填後端位址。
2. 確認存取名稱與後端連接埠，發佈到 tailnet。需要更多設定時可進入完整編輯頁，測試後端或儲存草稿。
3. 在「已發佈」中檢視存取位址、發佈狀態和後端連線結果，也可編輯、停用或刪除服務。

TCP 發佈連接埠預設與後端連接埠相同，可單獨設定。使用資料庫等對應用戶端連線顯示的 `主機名稱:發佈連接埠`，例如 `redis-cli -h redis.<tailnet>.ts.net -p 6379`，而不是用瀏覽器開啟。TCP 資料原樣轉發（包括後端自己的 TLS 協商），無需 Tailscale HTTPS 憑證。TCP 後端測試只驗證連接埠能夠建立連線，不驗證登入或應用協定。修改後端位址僅影響新 TCP 連線；修改協定或發佈連接埠、停用或刪除服務會關閉現有 TCP 連線。

停用或刪除服務只撤回當前節點的發佈，保留 Tailscale 控制台中的 Service 定義。

## 常見問題

- **節點授權提示 tag 無效或不允許：** 先按「連線設定」的指南設定 `tagOwners`，確認授權帳號有權使用該節點 tag，再重新授權。
- **Service 未定義或對節點不可見：** 檢查 Service 名稱、發佈連接埠（Web 為 `tcp:443`）、`tag:ztail-service` 和存取策略。點選錯誤中的「設定存取策略」可檢視當前服務的設定指南。
- **名稱與已有節點衝突：** 改用其他發佈名稱。例如節點已經叫 `ztail`，Service 可命名為 `ztail-web`。
- **已發佈但無法存取：** 「已發佈」不代表主機已獲審批。確認 Services 控制台中的 Service hosts 已批准 ztail 節點，以及用戶端具有存取權限。自動審批策略匹配時會自動批准；否則需手動審批。首次 HTTPS 憑證簽發可能需要數分鐘，剛發佈請稍候重試；頁面上的「無法存取已發佈的服務？」提供相關說明。
- **後端不可達：** 檢查所選環境、連接埠、服務執行狀態及叢集 DNS/網路。HTTPS 後端需提供有效憑證；限制 Host 的應用需允許發佈後的 tailnet 域名。
- **UDP 服務：** 暫不支援 UDP 發佈，目錄中的 UDP 連接埠僅供參考。

## License

MIT
