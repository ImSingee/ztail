import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowUpRight,
  Cloud,
  Check,
  Copy,
  Globe,
  Layers3,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { ServiceCatalog } from "./catalog";
import { PolicyError, PolicyGuide, PublishedAccessHelp } from "./policy-guide";
import "./style.css";

export type Named = { _id: string; name: string };
export type ServicePort = { id: string; port: number; type: string };
export type ServiceEnvironment = {
  status: string;
  ports: ServicePort[];
  error: string;
};
export type ZeaburService = Named & {
  dnsName: string;
  environments: Record<string, ServiceEnvironment>;
};
export type Project = Named & {
  environments: Named[];
  services: ZeaburService[];
};
export type Catalog = {
  server: Named;
  projects: Project[];
  updatedAt: string;
  error: string;
};
export type Tail = {
  state: string;
  authUrl: string;
  tailnet: string;
  dnsSuffix: string;
  hostname: string;
  dnsName: string;
  panelUrl: string;
  panelError: string;
  nodeId: string;
  tags: string[];
  ips: string[];
  magicDns: boolean;
  https: boolean;
  error: string;
  connecting?: boolean;
  connectMethod?: string;
  health?: string[];
};
export type Rule = {
  id: string;
  name: string;
  source: "manual" | "zeabur";
  projectId: string;
  environmentId: string;
  serviceId: string;
  host: string;
  protocol: "http" | "https";
  port: number;
  enabled: boolean;
  createService: boolean;
  revision: number;
  updatedAt: string;
};
export type RuleView = Rule & {
  target: string;
  status: {
    state: string;
    error: string;
    url: string;
    backend: string;
    approval: string;
    appliedRevision: number;
    activeUrl: string;
    activeTarget: string;
  };
};
export type Config = {
  serverId: string;
  nodeTag: string;
  serviceTag: string;
  clusterDomain: string;
  apiKeyConfigured: boolean;
  policy: unknown;
  withdrawalErrors: string[];
};
type Session = { authenticated: boolean; csrfToken: string; version?: string };
let csrf = "";
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    signal,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "/session")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}
function ruleData(r: Rule): Rule {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    projectId: r.projectId,
    environmentId: r.environmentId,
    serviceId: r.serviceId,
    host: r.host,
    protocol: r.protocol,
    port: r.port,
    enabled: r.enabled,
    createService: r.createService,
    revision: r.revision,
    updatedAt: r.updatedAt,
  };
}
const blank: Rule = {
  id: "",
  name: "",
  source: "zeabur",
  projectId: "",
  environmentId: "",
  serviceId: "",
  host: "",
  protocol: "http",
  port: 80,
  enabled: false,
  createService: false,
  revision: 0,
  updatedAt: "",
};
const states: Record<string, string> = {
  draft: "草稿 / 已停用",
  advertised: "已广告",
  error: "发布失败",
  update_failed: "更新失败 · 旧配置运行中",
  withdrawal_pending: "撤回待重试",
};
function ErrorBox({ message }: { message: string }) {
  return message ? (
    <div className="notice error" role="alert">
      {message}
    </div>
  ) : null;
}
function Busy() {
  return <LoaderCircle size={16} className="spin" aria-label="处理中" />;
}
function CopyButton({ value }: { value: string }) {
  const [copied, set] = useState(false);
  return (
    <button
      className="icon-button"
      title="复制地址"
      aria-label="复制地址"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          set(true);
          setTimeout(() => set(false), 1600);
        } catch {
          window.prompt("复制此地址", value);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [password, set] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-form">
        <div className="brand">
          <span className="brand-mark">
            <Layers3 size={21} />
          </span>
          ztail
        </div>
        <h1>登录服务发布面板</h1>
        <p className="muted">管理集群内的服务，连接你的 tailnet。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const s = await api<Session>("/session", "POST", { password });
              csrf = s.csrfToken;
              set("");
              onLogin(s);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="password">管理员密码</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            required
            autoFocus
            onChange={(e) => set(e.target.value)}
          />
          <ErrorBox message={error} />
          <button className="primary full" disabled={busy}>
            {busy ? <Busy /> : <ShieldCheck size={17} />}登录
          </button>
        </form>
        <p className="footnote">使用部署时配置的 ADMIN_PASSWORD。</p>
      </div>
    </main>
  );
}
function App() {
  const [session, setSession] = useState<Session | null>(null),
    [initial, setInitial] = useState(true),
    [path, setPath] = useState(location.pathname),
    [seed, setSeed] = useState<Rule | undefined>(history.state?.draft),
    [rules, setRules] = useState<RuleView[]>([]),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [tail, setTail] = useState<Tail | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<RuleView | null>(null),
    [policyRule, setPolicyRule] = useState<Rule | null>(null),
    [accessHelp, setAccessHelp] = useState(false);
  const tailVersion = useRef(0);
  const applyTailStatus = (status: Tail) => {
    tailVersion.current++;
    setTail(status);
  };
  const navigate = (p: string, draft?: Rule) => {
    setPolicyRule(null);
    setAccessHelp(false);
    history.pushState({ draft }, "", p);
    setSeed(draft);
    setPath(p);
    setError("");
    window.scrollTo(0, 0);
  };
  const load = async () => {
    const statusVersion = tailVersion.current;
    try {
      const [r, c, t, s] = await Promise.all([
        api<RuleView[]>("/rules"),
        api<Catalog>("/catalog"),
        api<Tail>("/tailscale"),
        api<Config>("/settings"),
      ]);
      setRules(r);
      setCatalog(c);
      if (tailVersion.current === statusVersion) setTail(t);
      setConfig(s);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    api<Session>("/session")
      .then((s) => {
        csrf = s.csrfToken;
        setSession(s);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setInitial(false));
    const pop = () => {
        setPath(location.pathname);
        setSeed(history.state?.draft);
        setPolicyRule(null);
        setAccessHelp(false);
      },
      expired = () => {
        csrf = "";
        setSession(null);
        setPolicyRule(null);
        setAccessHelp(false);
      };
    addEventListener("popstate", pop);
    addEventListener("session-expired", expired);
    return () => {
      removeEventListener("popstate", pop);
      removeEventListener("session-expired", expired);
    };
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [session?.authenticated]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (initial)
    return (
      <main className="loading">
        <Busy />
        正在读取会话…
        <ErrorBox message={error} />
      </main>
    );
  if (!session?.authenticated) return <Login onLogin={setSession} />;
  const editing = path.startsWith("/rules/"),
    settings = path === "/settings",
    browsing = path === "/",
    editID = path.split("/")[2],
    current = rules.find((r) => r.id === editID);
  return (
    <>
      <header className="topbar">
        <a
          href="/"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <span className="brand-mark">
            <Layers3 size={20} />
          </span>
          ztail
        </a>
        <nav aria-label="主导航">
          <a
            className={browsing ? "active" : ""}
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            <Cloud size={16} />
            Zeabur 服务
          </a>
          <a
            className={!settings && !browsing ? "active" : ""}
            href="/rules"
            onClick={(e) => {
              e.preventDefault();
              navigate("/rules");
            }}
          >
            <Globe size={16} />
            发布规则
          </a>
          <a
            className={settings ? "active" : ""}
            href="/settings"
            onClick={(e) => {
              e.preventDefault();
              navigate("/settings");
            }}
          >
            <Settings2 size={16} />
            连接设置
          </a>
        </nav>
        <button
          className="icon-button logout"
          aria-label="退出管理面板"
          title="退出管理面板"
          onClick={() =>
            void act(async () => {
              await api("/session", "DELETE");
              csrf = "";
              setSession(null);
            })
          }
        >
          <LogOut size={17} />
        </button>
      </header>
      <main className="workspace">
        <ErrorBox message={error} />
        <ErrorBox message={loadError} />
        {settings ? (
          <Connection
            config={config}
            tail={tail}
            catalog={catalog}
            onUpdate={load}
            onTailStatus={applyTailStatus}
          />
        ) : browsing ? (
          <ServiceCatalog
            catalog={catalog}
            config={config}
            tail={tail}
            rules={rules}
            onRefresh={async () => {
              await api("/catalog/refresh", "POST", {});
              await load();
            }}
            onPublish={async (rule) => {
              const saved = await api<Rule>("/rules", "POST", rule);
              await load();
              return saved;
            }}
            onConfigure={(draft) => navigate("/rules/new", draft)}
            onManage={(id) => navigate("/rules/" + id)}
            onSettings={() => navigate("/settings")}
            onPolicy={setPolicyRule}
          />
        ) : editing ? (
          <>
            {editID !== "new" && !current ? (
              <div className="notice">
                {config ? "规则不存在。" : "正在读取规则…"}
                <button onClick={() => navigate("/rules")}>返回规则</button>
              </div>
            ) : (
              <Editor
                key={editID}
                initial={current ? ruleData(current) : seed || blank}
                config={config}
                catalog={catalog}
                tail={tail}
                backLabel={seed ? "返回服务列表" : "返回发布规则"}
                onBack={() => navigate(seed ? "/" : "/rules")}
                onSaved={async () => {
                  await load();
                  navigate("/rules");
                }}
              />
            )}
          </>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <h1>发布规则</h1>
                <p className="muted">
                  选择后端服务，以独立的 HTTPS 名称发布到 tailnet。
                </p>
              </div>
              <button
                className="primary"
                onClick={() => navigate("/rules/new")}
              >
                <Plus size={17} />
                新增规则
              </button>
            </div>
            <div className="connection-strip">
              <span>
                <span
                  className={
                    "dot " + (tail?.state === "Running" ? "green" : "amber")
                  }
                />
                {tail?.state === "Running" ? tail.tailnet : "Tailscale 未连接"}
              </span>
              <span className="mono">{config?.nodeTag || "…"}</span>
              <div className="connection-actions">
                <button
                  className="text-button"
                  onClick={() => setAccessHelp(true)}
                >
                  无法访问已发布的规则？
                </button>
                <button
                  className="text-button"
                  onClick={() => navigate("/settings")}
                >
                  {tail?.state === "Running" ? "连接设置" : "完成节点接入"}
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </div>
            {!config ? (
              <div className="loading-inline">
                <Busy />
                正在读取规则…
              </div>
            ) : rules.length === 0 ? (
              <div className="empty">
                <Globe size={34} />
                <h2>还没有发布规则</h2>
                <p>
                  从 Zeabur 服务列表选择后端，或手填集群地址。
                  <br />
                  只有你明确启用的规则才会发布。
                </p>
                <button onClick={() => navigate("/")}>
                  <Cloud size={16} />
                  浏览 Zeabur 服务
                </button>
              </div>
            ) : (
              <div className="rule-table">
                <div className="table-head">
                  <span>名称 / 访问地址</span>
                  <span>后端服务</span>
                  <span>发布状态</span>
                  <span>操作</span>
                </div>
                {rules.map((r) => (
                  <article className="rule-row" key={r.id}>
                    <div>
                      <a
                        className="rule-name"
                        href={"/rules/" + r.id}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate("/rules/" + r.id);
                        }}
                      >
                        {r.name}
                      </a>
                      <div className="url-line">
                        <span className="mono">
                          {r.status.url || "加入 tailnet 后生成访问地址"}
                        </span>
                        {r.status.url && (
                          <>
                            <CopyButton value={r.status.url} />
                            <a
                              className="icon-button"
                              href={r.status.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={"访问 " + r.name}
                            >
                              <ArrowUpRight size={16} />
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="source-label">
                        {r.source === "zeabur" ? "Zeabur" : "手填地址"}
                      </span>
                      <div className="mono target">{r.target}</div>
                      <span
                        className={
                          "backend " +
                          (r.status.backend === "unreachable" ? "bad" : "")
                        }
                      >
                        {r.status.backend === "reachable"
                          ? "后端可达"
                          : r.status.backend === "unreachable"
                            ? "后端不可达"
                            : "尚未检测"}
                      </span>
                    </div>
                    <div>
                      <span
                        className={
                          "badge " +
                          (r.status.state === "advertised"
                            ? "success"
                            : r.status.error
                              ? "danger"
                              : "neutral")
                        }
                      >
                        {states[r.status.state] || "等待应用"}
                      </span>
                      {r.status.error && (
                        <>
                          <div className="row-error">
                            <PolicyError
                              message={r.status.error}
                              onOpen={() => setPolicyRule(ruleData(r))}
                            />
                          </div>
                          {r.status.activeUrl && (
                            <div className="status-note mono target">
                              当前入口：{r.status.activeUrl}
                              <br />
                              当前后端：{r.status.activeTarget}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api("/rules/" + r.id, "PUT", {
                              ...ruleData(r),
                              enabled: !r.enabled,
                            }),
                          )
                        }
                      >
                        {r.enabled ? "停用" : "发布"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => navigate("/rules/" + r.id)}
                      >
                        编辑
                      </button>
                      {r.status.error && (
                        <button
                          disabled={busy}
                          aria-label={"重试 " + r.name}
                          onClick={() =>
                            void act(() =>
                              api("/rules/" + r.id + "/retry", "POST", {}),
                            )
                          }
                        >
                          <RefreshCw size={14} />
                        </button>
                      )}
                      <button
                        disabled={busy}
                        className="icon-button"
                        aria-label={"删除 " + r.name}
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <p className="footnote">
              已广告表示本节点已配置并声明承载该 Service。访问仍受 tailnet
              审批与授权策略控制。
            </p>
          </>
        )}
      </main>
      <footer>
        ztail <span className="mono">{session.version || "dev"}</span>
      </footer>
      {accessHelp && (
        <PublishedAccessHelp onClose={() => setAccessHelp(false)} />
      )}
      {policyRule && (
        <PolicyGuide
          rule={policyRule}
          config={config}
          tail={tail}
          onClose={() => setPolicyRule(null)}
          onRetry={async () => {
            await api("/rules/" + policyRule.id + "/retry", "POST", {});
            await load();
          }}
        />
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDeleting(null);
                return;
              }
              if (e.key === "Tab") {
                const buttons = Array.from(
                  e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                const first = buttons[0],
                  last = buttons[buttons.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <h2 id="delete-title">删除 {deleting.name}？</h2>
            <p>
              将删除此规则并撤回本节点广告。Tailscale 中的 Service 定义会保留。
            </p>
            <div className="actions">
              <button autoFocus onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                className="destructive"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("/rules/" + deleting.id, "DELETE");
                    setDeleting(null);
                  })
                }
              >
                删除规则
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function Editor({
  initial,
  config,
  catalog,
  tail,
  onBack,
  onSaved,
  backLabel = "返回发布规则",
}: {
  initial: Rule;
  config: Config | null;
  catalog: Catalog | null;
  tail: Tail | null;
  onBack: () => void;
  onSaved: () => Promise<void>;
  backLabel?: string;
}) {
  const [form, setForm] = useState({ ...initial }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [probe, setProbe] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [localCatalog, setLocalCatalog] = useState<Catalog | null>(null);
  const cat = localCatalog || catalog,
    project = cat?.projects.find((p) => p._id === form.projectId);
  const update = <K extends keyof Rule>(key: K, value: Rule[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setProbe("");
  };
  const save = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await api(
        "/rules" + (form.id ? "/" + form.id : ""),
        form.id ? "PUT" : "POST",
        { ...form, enabled },
      );
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const target =
    form.source === "manual"
      ? `${form.protocol}://${form.host || "<后端地址>"}:${form.port}`
      : `${form.protocol}://service-${form.serviceId || "<服务 ID>"}.environment-${form.environmentId || "<环境 ID>"}.svc.${config?.clusterDomain || "cluster.local"}:${form.port}`;
  return (
    <>
      <button className="back text-button" onClick={onBack}>
        <ArrowLeft size={16} />
        {backLabel}
      </button>
      <div className="page-heading">
        <div>
          <h1>{form.id ? "编辑发布规则" : "新增发布规则"}</h1>
          <p className="muted">一个名称对应一个后端。保存草稿不会发布服务。</p>
        </div>
      </div>
      <form
        className="editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <section className="form-section">
          <h2>访问名称</h2>
          <label htmlFor="service-name">Service 名称</label>
          <input
            id="service-name"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="例如 grafana"
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            maxLength={63}
            required
            autoFocus
          />
          <p className="help">小写字母、数字和连字符，首尾不能为连字符。</p>
          <div className="domain-preview">
            <ShieldCheck size={17} />
            <span className="mono">
              https://{form.name || "<名称>"}.
              {tail?.dnsSuffix || "<tailnet>.ts.net"}
            </span>
          </div>
        </section>
        <section className="form-section">
          <div className="section-title">
            <h2>后端服务</h2>
            <button
              type="button"
              className="text-button"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  setLocalCatalog(
                    await api<Catalog>("/catalog/refresh", "POST", {}),
                  );
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? <Busy /> : <RefreshCw size={14} />}刷新目录
            </button>
          </div>
          <div className="segmented" role="group" aria-label="后端来源">
            <button
              type="button"
              aria-pressed={form.source === "zeabur"}
              onClick={() => update("source", "zeabur")}
            >
              Zeabur 服务
            </button>
            <button
              type="button"
              aria-pressed={form.source === "manual"}
              onClick={() => update("source", "manual")}
            >
              手填地址
            </button>
          </div>
          {form.source === "zeabur" ? (
            <>
              <ErrorBox message={cat?.error || ""} />
              <div className="field">
                <label htmlFor="project">项目</label>
                <select
                  id="project"
                  value={form.projectId}
                  required
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      projectId: e.target.value,
                      environmentId: "",
                      serviceId: "",
                    }))
                  }
                >
                  <option value="">选择项目</option>
                  {cat?.projects.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="environment">环境</label>
                  <select
                    id="environment"
                    value={form.environmentId}
                    disabled={!project}
                    required
                    onChange={(e) => update("environmentId", e.target.value)}
                  >
                    <option value="">选择环境</option>
                    {project?.environments.map((e) => (
                      <option key={e._id} value={e._id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="service">服务</label>
                  <select
                    id="service"
                    value={form.serviceId}
                    disabled={!project}
                    required
                    onChange={(e) => update("serviceId", e.target.value)}
                  >
                    <option value="">选择服务</option>
                    {project?.services.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="help">
                服务需实际部署在所选环境中。发布前可检测后端连通性。
              </p>
            </>
          ) : (
            <div className="field">
              <label htmlFor="backend-host">后端主机名或 IP</label>
              <input
                id="backend-host"
                value={form.host}
                required
                placeholder="grafana.monitoring.svc.cluster.local"
                onChange={(e) => update("host", e.target.value)}
              />
              <p className="help">只填地址，协议和端口单独设置。</p>
            </div>
          )}
          <div className="field-grid">
            <div className="field">
              <label htmlFor="protocol">后端协议</label>
              <select
                id="protocol"
                value={form.protocol}
                onChange={(e) =>
                  update("protocol", e.target.value as Rule["protocol"])
                }
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS（验证证书）</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="port">后端端口</label>
              <input
                id="port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                required
                onChange={(e) => update("port", Number(e.target.value))}
              />
            </div>
          </div>
          <div className="target-preview mono">{target}</div>
          <div className="probe-line">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setProbe("");
                setError("");
                try {
                  const res = await api<{ state: string }>(
                    "/probe",
                    "POST",
                    form,
                  );
                  setProbe(
                    res.state === "reachable" ? "后端可达" : "后端不可达",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              测试后端连接
            </button>
            {probe && (
              <span className="backend">
                <Check size={14} />
                {probe}
              </span>
            )}
          </div>
        </section>
        <section className="form-section">
          <h2>Tailscale Service</h2>
          {config?.apiKeyConfigured ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.createService}
                onChange={(e) => update("createService", e.target.checked)}
              />
              名称尚未定义时，通过 API 创建 Service
            </label>
          ) : (
            <p className="help">
              未配置 TAILSCALE_API_KEY。请先在 Tailscale 控制台定义{" "}
              <code>svc:{form.name || "<名称>"}</code>，端口为{" "}
              <code>tcp:443</code>，再发布此规则。
            </p>
          )}
          <p className="help">
            主机审批和访问授权遵循 tailnet 策略。已有 Service 定义不会被覆盖。
          </p>
        </section>
        <ErrorBox message={error} />
        <div className="editor-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(false)}
          >
            保存草稿{initial.enabled ? "并停用" : ""}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <Busy /> : <Globe size={16} />}保存并发布
          </button>
        </div>
      </form>
    </>
  );
}
function Connection({
  config,
  tail,
  catalog,
  onUpdate,
  onTailStatus,
}: {
  config: Config | null;
  tail: Tail | null;
  catalog: Catalog | null;
  onUpdate: () => Promise<void>;
  onTailStatus: (status: Tail) => void;
}) {
  const [key, setKey] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [busyMethod, setBusyMethod] = useState(""),
    [waitingForBrowser, setWaitingForBrowser] = useState(false),
    [authorizationUrl, setAuthorizationUrl] = useState(""),
    [hasInteractiveAttempt, setHasInteractiveAttempt] = useState(false),
    [openNotice, setOpenNotice] = useState(""),
    [copiedPolicy, setCopiedPolicy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (tail?.state === "Running" || tail?.state === "NeedsMachineAuth")
      setError("");
  }, [tail?.state]);
  useEffect(
    () => () => {
      pending.current?.abort();
    },
    [],
  );
  const connect = async (method: string) => {
    if (!config || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setBusyMethod(method);
    setError("");
    setOpenNotice("");
    setAuthorizationUrl("");
    setHasInteractiveAttempt(method === "interactive");
    setWaitingForBrowser(false);
    let timedOut = false;
    let authPageRequested = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90_000);
    try {
      await api(
        "/tailscale/connect",
        "POST",
        {
          method,
          authKey: method === "authkey" ? key : "",
        },
        controller.signal,
      );
      setKey("");
      for (;;) {
        const status = await api<Tail>(
          "/tailscale",
          "GET",
          undefined,
          controller.signal,
        );
        onTailStatus(status);
        if (status.state === "Running" || status.state === "NeedsMachineAuth") {
          break;
        }
        if (status.error) throw new Error(status.error);
        if (method === "interactive" && status.authUrl && !authPageRequested) {
          const url = new URL(status.authUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new Error("Tailscale 返回了无效的授权链接，请重试");
          authPageRequested = true;
          setWaitingForBrowser(true);
          setAuthorizationUrl(url.href);
          // Open only the final authorization page. Browsers that block
          // asynchronous popups get an explicit link in the original page.
          let opened: Window | null = null;
          try {
            opened = window.open(url.href, "_blank");
            if (opened) opened.opener = null;
          } catch {
            /* manual link remains available */
          }
          if (!opened)
            setOpenNotice(
              "授权链接已准备好。浏览器阻止了新标签页，请点击下方链接打开。",
            );
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 1000);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) {
            controller.signal.removeEventListener("abort", abort);
            abort();
          }
        });
      }
      if (!controller.signal.aborted) await onUpdate();
    } catch (e) {
      if (timedOut)
        setError(
          method === "authkey"
            ? "Auth Key 接入等待超过 90 秒，请检查网络、Key 和 tag 权限后重试；后台可能仍在尝试连接。"
            : authPageRequested
              ? "等待网页授权完成超过 90 秒，请完成授权或重试。"
              : "等待授权链接超过 90 秒，请检查 Tailscale 网络连接后重试。",
        );
      else if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted || timedOut) {
        setBusy(false);
        setBusyMethod("");
        setWaitingForBrowser(false);
      }
    }
  };
  const visibleAuthUrl =
    authorizationUrl || (!hasInteractiveAttempt ? tail?.authUrl : "");

  const connected = tail?.state === "Running";
  const activeMethod =
    busyMethod ||
    (tail?.connecting && !tail.error && !error ? tail.connectMethod : "");
  const interactivePending = activeMethod === "interactive";
  const keyPending = activeMethod === "authkey";
  const browserPending =
    waitingForBrowser || (!busyMethod && interactivePending && !!tail?.authUrl);
  // This notice is expected when ztail does not consume other subnet routes.
  const healthWarnings =
    tail?.health?.filter(
      (w) =>
        w.trim().replace(/\.$/, "") !==
        "Some peers are advertising routes but --accept-routes is false",
    ) || [];
  const policyGuide = (
    <section
      className="policy-section setup-policy"
      aria-labelledby="policy-heading"
    >
      <h2 id="policy-heading">
        {connected ? (
          "访问策略配置参考"
        ) : (
          <>
            <span className="setup-step">1</span>先配置 Tailscale 策略
          </>
        )}
      </h2>
      <p>
        {connected ? "节点使用" : "节点授权会申请"}{" "}
        <code>{config?.nodeTag}</code>。
        {connected
          ? "调整权限时，将下方条目合并到现有策略。"
          : "请先在 Tailscale 中定义 tag 和权限，再进行下方授权。"}
      </p>
      <div className="notice policy-merge-notice">
        <strong>这是策略片段：合并到现有策略，勿覆盖整份策略。</strong>
        <p>
          保留现有配置：将 <code>tagOwners</code> 和{" "}
          <code>autoApprovers.services</code> 中的条目合并到对应字段，将{" "}
          <code>grants</code> 条目追加到现有数组。
        </p>
      </div>
      <ol className="policy-instructions">
        <li>打开访问策略，将下方片段合并到已有配置，并保存。</li>
        <li>
          访问来源可按团队需求调整。保留配置的节点 tag 和 Service tag 权限。
        </li>
        <li>在 DNS 设置中开启 MagicDNS 和 HTTPS，供后续 Service 发布使用。</li>
      </ol>
      <div className="actions">
        <a
          className="button-link primary"
          href="https://login.tailscale.com/admin/acls"
          target="_blank"
          rel="noreferrer"
        >
          打开 Tailscale 访问策略
          <ArrowUpRight size={15} />
        </a>
        <button
          disabled={!config}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                JSON.stringify(config?.policy, null, 2),
              );
              setCopiedPolicy(true);
            } catch {
              setError("无法复制策略片段，请展开下方内容手动复制。");
            }
          }}
        >
          <Copy size={15} />
          {copiedPolicy ? "已复制策略片段" : "复制待合并的策略片段"}
        </button>
        <a
          href="https://login.tailscale.com/admin/dns"
          target="_blank"
          rel="noreferrer"
        >
          DNS 设置
          <ArrowUpRight size={15} />
        </a>
      </div>
      <details className="policy-preview" open>
        <summary>查看需要合并的策略片段</summary>
        <p className="help">只合并以下条目，保留现有的其他策略。</p>
        <pre>
          {config
            ? JSON.stringify(config.policy, null, 2)
            : "正在读取策略片段…"}
        </pre>
      </details>

      <p className="help">策略由你在 Tailscale 中保存，ztail 不会替你修改。</p>
    </section>
  );
  const serverContext = (
    <section className="server-context">
      <h2>Zeabur 服务器</h2>
      <dl className="server-facts">
        <div>
          <dt>服务器</dt>
          <dd>{catalog?.server.name || "等待目录同步"}</dd>
        </div>
        <div>
          <dt>Server ID</dt>
          <dd className="mono">{config?.serverId}</dd>
        </div>
        <div>
          <dt>集群 DNS 后缀</dt>
          <dd className="mono">{config?.clusterDomain}</dd>
        </div>
        <div>
          <dt>目录更新时间</dt>
          <dd>
            {catalog?.updatedAt
              ? new Date(catalog.updatedAt).toLocaleString()
              : "尚未同步"}
          </dd>
        </div>
      </dl>
      <ErrorBox message={catalog?.error || ""} />
      <ErrorBox message={config?.withdrawalErrors?.join("；") || ""} />
      <p className="help">
        通过 ZEABUR_SERVER_ID 固定服务器，API Key 由环境变量提供。
      </p>
    </section>
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>连接设置</h1>
          <p className="muted">
            {connected
              ? "查看服务器与节点连接状态，按需调整访问策略。"
              : "先合并并保存访问策略，再授权节点加入 tailnet。"}
          </p>
        </div>
        <button onClick={() => void onUpdate()}>
          <RefreshCw size={15} />
          刷新状态
        </button>
      </div>
      <div
        className={connected ? "settings-grid connected-settings" : undefined}
      >
        {serverContext}
        {tail && !connected && policyGuide}
        <div className="node-settings">
          <section className="settings-section">
            <h2>
              {connected || !tail ? (
                "Tailscale 节点"
              ) : (
                <>
                  <span className="setup-step">2</span>授权 Tailscale 节点
                </>
              )}
            </h2>
            {!tail && (
              <p className="help" role="status">
                正在读取节点连接状态…
              </p>
            )}
            <dl>
              <dt>连接状态</dt>
              <dd>
                <span
                  className={
                    "badge " +
                    (tail?.state === "Running" ? "success" : "neutral")
                  }
                >
                  {tail?.state === "Running"
                    ? "已连接"
                    : tail?.state === "NeedsMachineAuth"
                      ? "等待节点审批"
                      : busy || tail?.connecting
                        ? "接入中"
                        : tail?.state === "NeedsLogin"
                          ? "等待授权"
                          : tail?.state || "读取中"}
                </span>
              </dd>
              <dt>Tailnet</dt>
              <dd>{tail?.tailnet || "—"}</dd>
              <dt>节点</dt>
              <dd>{tail?.hostname || "ztail"}</dd>
              <dt>面板 HTTPS 地址</dt>
              <dd>
                {tail?.panelUrl ? (
                  <a
                    href={tail.panelUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                  >
                    {tail.panelUrl}
                  </a>
                ) : !tail ? (
                  "正在读取…"
                ) : tail.state !== "Running" ? (
                  "连接后可用"
                ) : !tail.magicDns || !tail.https ? (
                  "请开启 MagicDNS 和 HTTPS"
                ) : tail.panelError ? (
                  "暂不可用，正在重试"
                ) : (
                  "正在准备 HTTPS 入口…"
                )}
                {tail?.panelUrl && (
                  <p className="help">
                    通过 tailnet 访问，仍需管理员密码。若无法连接，请检查节点的
                    TCP 443 访问权限。
                  </p>
                )}
              </dd>
              <dt>配置的 tag</dt>
              <dd className="mono">{config?.nodeTag}</dd>
              <dt>实际 tag</dt>
              <dd className="mono">
                {tail?.tags?.join(", ") || "尚未获得 tag"}
              </dd>
              <dt>MagicDNS / HTTPS</dt>
              <dd>
                {tail?.magicDns ? "已开启" : "未确认"} /{" "}
                {tail?.https ? "已开启" : "未确认"}
              </dd>
              <dt>API Key</dt>
              <dd>
                {config?.apiKeyConfigured
                  ? "已配置 · 发布时校验权限"
                  : "未配置 · 绑定已有 Service"}
              </dd>
            </dl>
            <ErrorBox message={tail?.error || ""} />
            <ErrorBox
              message={
                tail?.panelError ? "面板 HTTPS 入口：" + tail.panelError : ""
              }
            />
            {healthWarnings.length ? (
              <div className="notice" role="status">
                Tailscale 健康提示：{healthWarnings.join("；")}
              </div>
            ) : null}
            <ErrorBox message={error !== tail?.error ? error : ""} />
            {tail?.state === "NeedsMachineAuth" && (
              <div className="notice">
                节点已接入，等待管理员审批。
                <a
                  href="https://login.tailscale.com/admin/machines"
                  target="_blank"
                  rel="noreferrer"
                >
                  打开节点管理
                </a>
              </div>
            )}
            {tail &&
              tail.state !== "Running" &&
              tail.state !== "NeedsMachineAuth" && (
                <div className="auth-controls">
                  <p className="help">请先保存上方合并后的策略，再开始授权。</p>
                  <button
                    className="primary"
                    disabled={busy || !config}
                    aria-busy={interactivePending}
                    onClick={() => void connect("interactive")}
                  >
                    {interactivePending ? <Busy /> : <ArrowUpRight size={16} />}
                    {interactivePending
                      ? browserPending
                        ? "等待授权完成…"
                        : "正在获取授权链接…"
                      : "交互式授权"}
                  </button>
                  {interactivePending && (
                    <p className="help" role="status">
                      {browserPending
                        ? "请在 Tailscale 页面完成授权，ztail 正在等待连接确认。"
                        : "正在获取授权链接，准备好后会自动打开。"}
                    </p>
                  )}
                  {visibleAuthUrl &&
                    !tail?.connecting &&
                    tail?.connectMethod === "authkey" && (
                      <p className="help">
                        Tailscale
                        仍要求网页授权，请打开下方链接完成授权，或使用有效且有权分配节点
                        tag 的 Auth Key 重试。
                      </p>
                    )}
                  {openNotice && (
                    <div className="notice" role="status">
                      {openNotice}
                    </div>
                  )}
                  {visibleAuthUrl &&
                    (!interactivePending || browserPending) &&
                    !(tail?.connecting && tail.connectMethod === "authkey") && (
                      <a
                        className="authorization-link"
                        href={visibleAuthUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开 Tailscale 授权页面
                        <ArrowUpRight size={15} />
                      </a>
                    )}
                  <p className="help">
                    点击后会等待授权链接并自动打开新标签页。授权账号需要有权分配配置的
                    tag；完成后状态会自动更新。
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void connect("authkey");
                    }}
                  >
                    <label htmlFor="auth-key">或使用 Auth Key</label>
                    <input
                      id="auth-key"
                      type="password"
                      autoComplete="off"
                      value={key}
                      placeholder="tskey-auth-…"
                      required
                      onChange={(e) => setKey(e.target.value)}
                    />
                    <button disabled={busy || !config} aria-busy={keyPending}>
                      {keyPending && <Busy />}使用 Auth Key 加入
                    </button>
                    {keyPending && (
                      <p className="help" role="status">
                        正在使用 Auth Key 接入，等待 Tailscale 确认…
                      </p>
                    )}
                  </form>
                </div>
              )}
          </section>
        </div>
      </div>
      {connected && (
        <details className="connected-policy">
          <summary>访问策略与合并片段</summary>
          <p className="help">节点已连接，需要调整权限时可展开查看。</p>
          {policyGuide}
        </details>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
