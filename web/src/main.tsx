import {
  useI18n,
  LanguageSwitcher,
  I18nProvider,
  asMessage,
  LocalizedError,
  type Message,
  type MessageInfo,
  RichText,
} from "./i18n";
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
import {
  accessPreview,
  connectionAddress,
  isWebAddress,
  publicPort,
} from "./rule-helpers";
import { PolicyError, PolicyGuide, PublishedAccessHelp } from "./policy-guide";
import "./style.css";

export type Named = { _id: string; name: string };
export type ServicePort = { id: string; port: number; type: string };
export type ServiceEnvironment = {
  status: string;
  ports: ServicePort[];
  error: string;
  errorInfo?: MessageInfo;
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
  errorInfo?: MessageInfo;
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
  panelErrorInfo?: MessageInfo;
  nodeId: string;
  tags: string[];
  ips: string[];
  magicDns: boolean;
  https: boolean;
  error: string;
  errorInfo?: MessageInfo;
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
  protocol: "http" | "https" | "tcp";
  port: number;
  publishPort: number;
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
    errorInfo?: MessageInfo;
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
  policy: {
    tagOwners: Record<string, string[]>;
    autoApprovers: { services: Record<string, string[]> };
    grants: { src: string[]; dst: string[]; ip: string[] }[];
  };
  withdrawalErrors: string[];
  withdrawalErrorInfos?: MessageInfo[];
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
    throw new LocalizedError(
      data.errorInfo ||
        data.error || { key: "Request failed ({0})", args: [res.status] },
    );
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
    publishPort: publicPort(r),
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
  publishPort: 443,
  enabled: false,
  createService: false,
  revision: 0,
  updatedAt: "",
};
const states: Record<string, string> = {
  draft: "Draft / Disabled",
  advertised: "Published",
  error: "Publish failed",
  update_failed: "Update failed · Previous configuration active",
  withdrawal_pending: "Withdrawal pending retry",
};
function ErrorBox({ message: value }: { message: Message }) {
  const { message } = useI18n();
  return value ? (
    <div className="notice error" role="alert">
      {message(value)}
    </div>
  ) : null;
}
function Busy() {
  const { t } = useI18n();
  return (
    <LoaderCircle size={16} className="spin" aria-label={t("Processing")} />
  );
}
function CopyButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, set] = useState(false);
  return (
    <button
      className="icon-button"
      title={t("Copy address")}
      aria-label={t("Copy address")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          set(true);
          setTimeout(() => set(false), 1600);
        } catch {
          window.prompt(t("Copy this address"), value);
        }
      }}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const { t } = useI18n();
  const [password, set] = useState(""),
    [error, setError] = useState<Message>(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-form">
        <div className="login-heading">
          <div className="brand">
            <span className="brand-mark">
              <Layers3 size={21} />
            </span>
            ztail
          </div>
          <LanguageSwitcher />
        </div>
        <h1>{t("Sign in to the publishing console")}</h1>
        <p className="muted">
          {t("Manage cluster services and connect your tailnet.")}
        </p>
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
              setError(asMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="password">{t("Admin password")}</label>
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
            {busy ? <Busy /> : <ShieldCheck size={17} />}
            {t("Sign in")}
          </button>
        </form>
        <p className="footnote">
          {t("Use the ADMIN_PASSWORD configured for this deployment.")}
        </p>
      </div>
    </main>
  );
}
function canonicalPagePath(path: string) {
  return path.replace(/^\/rules(?=\/|$)/, "/services");
}
function readPagePath() {
  const path = canonicalPagePath(location.pathname);
  if (path !== location.pathname)
    history.replaceState(
      history.state,
      "",
      path + location.search + location.hash,
    );
  return path;
}
function App() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null),
    [initial, setInitial] = useState(true),
    [path, setPath] = useState(() => canonicalPagePath(location.pathname)),
    [seed, setSeed] = useState<Rule | undefined>(history.state?.draft),
    [rules, setRules] = useState<RuleView[]>([]),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [tail, setTail] = useState<Tail | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState<Message>(""),
    [loadError, setLoadError] = useState<Message>(""),
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
      setLoadError(asMessage(e));
    }
  };
  useEffect(() => {
    readPagePath();
    api<Session>("/session")
      .then((s) => {
        csrf = s.csrfToken;
        setSession(s);
      })
      .catch((e) => setError(asMessage(e)))
      .finally(() => setInitial(false));
    const pop = () => {
        setPath(readPagePath());
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
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (initial)
    return (
      <main className="loading">
        <Busy />
        {t("Loading session…")}
        <ErrorBox message={error} />
      </main>
    );
  if (!session?.authenticated) return <Login onLogin={setSession} />;
  const editing = path.startsWith("/services/"),
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
        <nav aria-label={t("Main navigation")}>
          <a
            className={browsing ? "active" : ""}
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            <Cloud size={16} />
            {t("Zeabur services")}
          </a>
          <a
            className={!settings && !browsing ? "active" : ""}
            href="/services"
            onClick={(e) => {
              e.preventDefault();
              navigate("/services");
            }}
          >
            <Globe size={16} />
            {t("Published")}
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
            {t("Connection settings")}
          </a>
        </nav>
        <LanguageSwitcher />
        <button
          className="icon-button logout"
          aria-label={t("Sign out of the console")}
          title={t("Sign out of the console")}
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
            onConfigure={(draft) => navigate("/services/new", draft)}
            onManage={(id) => navigate("/services/" + id)}
            onSettings={() => navigate("/settings")}
            onPolicy={setPolicyRule}
          />
        ) : editing ? (
          <>
            {editID !== "new" && !current ? (
              <div className="notice">
                {config ? t("Service not found.") : t("Loading services…")}
                <button onClick={() => navigate("/services")}>
                  {t("Back to published services")}
                </button>
              </div>
            ) : (
              <Editor
                key={editID}
                initial={current ? ruleData(current) : seed || blank}
                config={config}
                catalog={catalog}
                tail={tail}
                backLabel={
                  seed
                    ? t("Back to service catalog")
                    : t("Back to published services")
                }
                onBack={() => navigate(seed ? "/" : "/services")}
                onSaved={async () => {
                  await load();
                  navigate("/services");
                }}
              />
            )}
          </>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <h1>{t("Published")}</h1>
                <p className="muted">
                  {t(
                    "Choose a Web or TCP backend and publish it to your tailnet under its own name.",
                  )}
                </p>
              </div>
              <button
                className="primary"
                onClick={() => navigate("/services/new")}
              >
                <Plus size={17} />
                {t("Publish")}
              </button>
            </div>
            <div className="connection-strip">
              <span>
                <span
                  className={
                    "dot " + (tail?.state === "Running" ? "green" : "amber")
                  }
                />
                {tail?.state === "Running"
                  ? tail.tailnet
                  : t("Tailscale disconnected")}
              </span>
              <span className="mono">{config?.nodeTag || "…"}</span>
              <div className="connection-actions">
                <button
                  className="text-button"
                  onClick={() => setAccessHelp(true)}
                >
                  {t("Can't access a published service?")}
                </button>
                <button
                  className="text-button"
                  onClick={() => navigate("/settings")}
                >
                  {tail?.state === "Running"
                    ? t("Connection settings")
                    : t("Connect this node")}
                  <ArrowUpRight size={14} />
                </button>
              </div>
            </div>
            {!config ? (
              <div className="loading-inline">
                <Busy />
                {t("Loading services…")}
              </div>
            ) : rules.length === 0 ? (
              <div className="empty">
                <Globe size={34} />
                <h2>{t("No published services yet")}</h2>
                <p>
                  {t(
                    "Choose a backend from the Zeabur catalog or enter a cluster address.",
                  )}
                  <br />
                  {t(
                    "The service joins your tailnet when you confirm publishing.",
                  )}
                </p>
                <button onClick={() => navigate("/")}>
                  <Cloud size={16} />
                  {t("Browse Zeabur services")}
                </button>
              </div>
            ) : (
              <div className="rule-table">
                <div className="table-head">
                  <span>{t("Name / Address")}</span>
                  <span>{t("Backend service")}</span>
                  <span>{t("Publishing status")}</span>
                  <span>{t("Actions")}</span>
                </div>
                {rules.map((r) => (
                  <article className="rule-row" key={r.id}>
                    <div>
                      <a
                        className="rule-name"
                        href={"/services/" + r.id}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate("/services/" + r.id);
                        }}
                      >
                        {r.name}
                      </a>
                      <div className="url-line">
                        <span className="mono">
                          {connectionAddress(r.status.url) ||
                            t(
                              "An address will be available after joining the tailnet",
                            )}
                        </span>
                        {r.status.url && (
                          <>
                            <CopyButton
                              value={connectionAddress(r.status.url)}
                            />
                            {isWebAddress(r.status.url) && (
                              <a
                                className="icon-button"
                                href={r.status.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={t("Visit ") + r.name}
                              >
                                <ArrowUpRight size={16} />
                              </a>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="source-label">
                        {r.source === "zeabur" ? "Zeabur" : t("Manual address")}
                      </span>
                      <div className="mono target">{r.target}</div>
                      <span
                        className={
                          "backend " +
                          (r.status.backend === "unreachable" ? "bad" : "")
                        }
                      >
                        {r.status.backend === "reachable"
                          ? r.protocol === "tcp"
                            ? t("TCP port reachable")
                            : t("Backend reachable")
                          : r.status.backend === "unreachable"
                            ? t("Backend unreachable")
                            : t("Not tested")}
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
                        {t(states[r.status.state] || "Awaiting apply")}
                      </span>
                      {r.status.error && (
                        <>
                          <div className="row-error">
                            <PolicyError
                              message={r.status.errorInfo || r.status.error}
                              onOpen={() => setPolicyRule(ruleData(r))}
                            />
                          </div>
                          {r.status.activeUrl && (
                            <div className="status-note mono target">
                              {t("Active endpoint: ")}
                              {connectionAddress(r.status.activeUrl)}
                              <br />
                              {t("Active backend: ")}
                              {r.status.activeTarget}
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
                        {r.enabled ? t("Disable") : t("Publish")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => navigate("/services/" + r.id)}
                      >
                        {t("Edit")}
                      </button>
                      {r.status.error && (
                        <button
                          disabled={busy}
                          aria-label={t("Retry ") + r.name}
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
                        aria-label={t("Delete service ") + r.name}
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
              {t(
                "Published means this node is configured and advertises the Service. Access still depends on tailnet approval and access policies.",
              )}
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
            <h2 id="delete-title">{t("Delete service {0}?", deleting.name)}</h2>
            <p>
              {t(
                "Remove this service from ztail and withdraw this node's advertisement. The Tailscale Service definition will remain.",
              )}
            </p>
            <div className="actions">
              <button autoFocus onClick={() => setDeleting(null)}>
                {t("Cancel")}
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
                {t("Delete service")}
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
  backLabel = "Back to published services",
}: {
  initial: Rule;
  config: Config | null;
  catalog: Catalog | null;
  tail: Tail | null;
  onBack: () => void;
  onSaved: () => Promise<void>;
  backLabel?: string;
}) {
  const { t, message } = useI18n();
  const [form, setForm] = useState({
      ...initial,
      publishPort: publicPort(initial),
    }),
    [publishPortEdited, setPublishPortEdited] = useState(
      !!initial.id ||
        (initial.protocol === "tcp" && publicPort(initial) !== initial.port),
    ),
    [error, setError] = useState<Message>(""),
    [busy, setBusy] = useState(false),
    [probe, setProbe] = useState<Message>(""),
    [refreshing, setRefreshing] = useState(false),
    [localCatalog, setLocalCatalog] = useState<Catalog | null>(null);
  const cat = localCatalog || catalog,
    project = cat?.projects.find((p) => p._id === form.projectId);
  const update = <K extends keyof Rule>(key: K, value: Rule[K]) => {
    if (key === "publishPort") setPublishPortEdited(true);
    if (key === "protocol") setPublishPortEdited(!!form.id);
    setForm((f) => ({
      ...f,
      [key]: value,
      ...(key === "protocol"
        ? { publishPort: value === "tcp" ? f.port : 443 }
        : key === "port" && f.protocol === "tcp" && !publishPortEdited
          ? { publishPort: Number(value) }
          : {}),
    }));
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
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const target =
    form.source === "manual"
      ? `${form.protocol}://${form.host || t("<backend address>")}:${form.port}`
      : `${form.protocol}://service-${form.serviceId || t("<service ID>")}.environment-${form.environmentId || t("<environment ID>")}.svc.${config?.clusterDomain || "cluster.local"}:${form.port}`;
  return (
    <>
      <button className="back text-button" onClick={onBack}>
        <ArrowLeft size={16} />
        {t(backLabel)}
      </button>
      <div className="page-heading">
        <div>
          <h1>{form.id ? t("Edit service") : t("Publish service")}</h1>
          <p className="muted">
            {t(
              "Each name maps to one backend. Saving a draft does not publish the service.",
            )}
          </p>
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
          <h2>{t("Access name")}</h2>
          <label htmlFor="service-name">{t("Service name")}</label>
          <input
            id="service-name"
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder={t("e.g. grafana")}
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            maxLength={63}
            required
            autoFocus
          />
          <p className="help">
            {t(
              "Use lowercase letters, digits and hyphens. A name cannot start or end with a hyphen.",
            )}
          </p>
          <div className="domain-preview">
            <ShieldCheck size={17} />
            <span className="mono">
              {accessPreview(form, tail?.dnsSuffix, t("<name>"))}
            </span>
          </div>
          {form.protocol === "tcp" && (
            <div className="field">
              <label htmlFor="publish-port">{t("Published port")}</label>
              <input
                id="publish-port"
                type="number"
                min={1}
                max={65535}
                required
                value={form.publishPort}
                onChange={(e) => update("publishPort", Number(e.target.value))}
              />
              <p className="help">
                {t(
                  "Clients connect to this port; the backend port is independent. Use the appropriate client, such as a database client. TCP data is forwarded unchanged.",
                )}
              </p>
            </div>
          )}
        </section>
        <section className="form-section">
          <div className="section-title">
            <h2>{t("Backend service")}</h2>
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
                  setError(asMessage(e));
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? <Busy /> : <RefreshCw size={14} />}
              {t("Refresh catalog")}
            </button>
          </div>
          <div
            className="segmented"
            role="group"
            aria-label={t("Backend source")}
          >
            <button
              type="button"
              aria-pressed={form.source === "zeabur"}
              onClick={() => update("source", "zeabur")}
            >
              {t("Zeabur services")}
            </button>
            <button
              type="button"
              aria-pressed={form.source === "manual"}
              onClick={() => update("source", "manual")}
            >
              {t("Manual address")}
            </button>
          </div>
          {form.source === "zeabur" ? (
            <>
              <ErrorBox message={cat?.errorInfo || cat?.error || ""} />
              <div className="field">
                <label htmlFor="project">{t("Project")}</label>
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
                  <option value="">{t("Select a project")}</option>
                  {cat?.projects.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="environment">{t("Environment")}</label>
                  <select
                    id="environment"
                    value={form.environmentId}
                    disabled={!project}
                    required
                    onChange={(e) => update("environmentId", e.target.value)}
                  >
                    <option value="">{t("Select an environment")}</option>
                    {project?.environments.map((e) => (
                      <option key={e._id} value={e._id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="service">{t("Service")}</label>
                  <select
                    id="service"
                    value={form.serviceId}
                    disabled={!project}
                    required
                    onChange={(e) => update("serviceId", e.target.value)}
                  >
                    <option value="">{t("Select a service")}</option>
                    {project?.services.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="help">
                {t(
                  "The service must be deployed in the selected environment. You can test backend connectivity before publishing.",
                )}
              </p>
            </>
          ) : (
            <div className="field">
              <label htmlFor="backend-host">
                {t("Backend hostname or IP")}
              </label>
              <input
                id="backend-host"
                value={form.host}
                required
                placeholder="grafana.monitoring.svc.cluster.local"
                onChange={(e) => update("host", e.target.value)}
              />
              <p className="help">
                {t(
                  "Enter only the address; set the protocol and port separately.",
                )}
              </p>
            </div>
          )}
          <div className="field-grid">
            <div className="field">
              <label htmlFor="protocol">{t("Backend protocol")}</label>
              <select
                id="protocol"
                value={form.protocol}
                onChange={(e) =>
                  update("protocol", e.target.value as Rule["protocol"])
                }
              >
                <option value="http">HTTP</option>
                <option value="https">{t("HTTPS (verify certificate)")}</option>
                <option value="tcp">{t("TCP (forward unchanged)")}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="port">{t("Backend port")}</label>
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
                    res.state === "reachable"
                      ? form.protocol === "tcp"
                        ? "TCP port reachable (application protocol not verified)"
                        : "Backend reachable"
                      : "Backend unreachable",
                  );
                } catch (e) {
                  setError(asMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Test backend connection")}
            </button>
            {probe && (
              <span className="backend">
                <Check size={14} />
                {message(probe)}
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
              {t(
                "Create the Service through the API if this name is not yet defined",
              )}
            </label>
          ) : (
            <p className="help">
              {t(
                "TAILSCALE_API_KEY is not configured. First define {0} with port {1} in the Tailscale console, then publish this rule.",
                `svc:${form.name || t("<name>")}`,
                `tcp:${publicPort(form)}`,
              )}
            </p>
          )}
          <p className="help">
            {t(
              "Host approval and access follow your tailnet policy. Existing Service definitions will not be overwritten.",
            )}
          </p>
        </section>
        <ErrorBox message={error} />
        <div className="editor-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(false)}
          >
            {t(initial.enabled ? "Save draft and disable" : "Save draft")}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <Busy /> : <Globe size={16} />}
            {t("Save and publish")}
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
  const { t, message, locale } = useI18n();
  const [key, setKey] = useState(""),
    [error, setError] = useState<Message>(""),
    [busy, setBusy] = useState(false),
    [busyMethod, setBusyMethod] = useState(""),
    [waitingForBrowser, setWaitingForBrowser] = useState(false),
    [authorizationUrl, setAuthorizationUrl] = useState(""),
    [hasInteractiveAttempt, setHasInteractiveAttempt] = useState(false),
    [openNotice, setOpenNotice] = useState<Message>(""),
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
        if (status.error)
          throw new LocalizedError(status.errorInfo || status.error);
        if (method === "interactive" && status.authUrl && !authPageRequested) {
          const url = new URL(status.authUrl);
          if (url.protocol !== "https:" && url.protocol !== "http:")
            throw new LocalizedError(
              "Tailscale returned an invalid authorization URL. Please retry.",
            );
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
              "The authorization URL is ready. Your browser blocked the new tab; use the link below to open it.",
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
            ? "Auth Key enrollment has taken over 90 seconds. Check the network, key and tag permissions, then retry. Connection attempts may continue in the background."
            : authPageRequested
              ? "Web authorization has taken over 90 seconds. Complete authorization or retry."
              : "Waiting for an authorization URL has taken over 90 seconds. Check the Tailscale network connection, then retry.",
        );
      else if (!controller.signal.aborted) setError(asMessage(e));
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
          t("Access policy reference")
        ) : (
          <>
            <span className="setup-step">1</span>
            {t("Configure the Tailscale policy first")}
          </>
        )}
      </h2>
      <p>
        {t(
          "The node uses {0}. Merge the entries below into your existing policy before authorizing the node or adjusting permissions.",
          config?.nodeTag || "…",
        )}
      </p>
      <div className="notice policy-merge-notice">
        <strong>
          {t(
            "This is a policy fragment. Merge it into your existing policy; do not replace the entire policy.",
          )}
        </strong>
        <p>
          <RichText
            id="Keep the existing configuration: merge {0} and {1} entries into their corresponding fields, and append {2} entries to the existing array."
            values={[
              <code>tagOwners</code>,
              <code>autoApprovers.services</code>,
              <code>grants</code>,
            ]}
          />
        </p>
      </div>
      <ol className="policy-instructions">
        <li>
          {t(
            "Open Access controls, merge the fragment below into your existing configuration, and save.",
          )}
        </li>
        <li>
          {t(
            "Adjust access sources for your team. Keep the configured node and Service tag permissions.",
          )}
        </li>
        <li>
          {t(
            "Enable MagicDNS and HTTPS in DNS settings for subsequent Service publishing.",
          )}
        </li>
      </ol>
      <div className="actions">
        <a
          className="button-link primary"
          href="https://login.tailscale.com/admin/acls"
          target="_blank"
          rel="noreferrer"
        >
          {t("Open Tailscale Access controls")}
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
              setError(
                "Could not copy the policy fragment. Expand it below and copy it manually.",
              );
            }
          }}
        >
          <Copy size={15} />
          {copiedPolicy
            ? t("Policy fragment copied")
            : t("Copy the policy fragment to merge")}
        </button>
        <a
          href="https://login.tailscale.com/admin/dns"
          target="_blank"
          rel="noreferrer"
        >
          {t("DNS settings")}
          <ArrowUpRight size={15} />
        </a>
      </div>
      <details className="policy-preview" open>
        <summary>{t("Show the policy fragment to merge")}</summary>
        <p className="help">
          {t(
            "Merge only the entries below, keeping all other existing policies.",
          )}
        </p>
        <pre>
          {config
            ? JSON.stringify(config.policy, null, 2)
            : t("Loading policy fragment…")}
        </pre>
      </details>

      <p className="help">
        {t(
          "You save the policy in Tailscale; ztail does not modify it for you.",
        )}
      </p>
    </section>
  );
  const serverContext = (
    <section className="server-context">
      <h2>{t("Zeabur server")}</h2>
      <dl className="server-facts">
        <div>
          <dt>{t("Server")}</dt>
          <dd>{catalog?.server.name || t("Waiting for catalog sync")}</dd>
        </div>
        <div>
          <dt>Server ID</dt>
          <dd className="mono">{config?.serverId}</dd>
        </div>
        <div>
          <dt>{t("Cluster DNS suffix")}</dt>
          <dd className="mono">{config?.clusterDomain}</dd>
        </div>
        <div>
          <dt>{t("Catalog updated")}</dt>
          <dd>
            {catalog?.updatedAt
              ? new Date(catalog.updatedAt).toLocaleString(locale)
              : t("Not synced yet")}
          </dd>
        </div>
      </dl>
      <ErrorBox message={catalog?.errorInfo || catalog?.error || ""} />
      <ErrorBox
        message={
          (
            config?.withdrawalErrorInfos?.map(message) ||
            config?.withdrawalErrors
          )?.join("; ") || ""
        }
      />
    </section>
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t("Connection settings")}</h1>
          <p className="muted">
            {connected
              ? t(
                  "Check the server and node connection status, and adjust access policies as needed.",
                )
              : t(
                  "Merge and save the access policy before authorizing this node to join your tailnet.",
                )}
          </p>
        </div>
        <button onClick={() => void onUpdate()}>
          <RefreshCw size={15} />
          {t("Refresh status")}
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
                t("Tailscale node")
              ) : (
                <>
                  <span className="setup-step">2</span>
                  {t("Authorize this Tailscale node")}
                </>
              )}
            </h2>
            {!tail && (
              <p className="help" role="status">
                {t("Loading node connection status…")}
              </p>
            )}
            <dl>
              <dt>{t("Connection status")}</dt>
              <dd>
                <span
                  className={
                    "badge " +
                    (tail?.state === "Running" ? "success" : "neutral")
                  }
                >
                  {tail?.state === "Running"
                    ? t("Connected")
                    : tail?.state === "NeedsMachineAuth"
                      ? t("Awaiting node approval")
                      : busy || tail?.connecting
                        ? t("Connecting")
                        : tail?.state === "NeedsLogin"
                          ? t("Awaiting authorization")
                          : t(tail?.state || "Loading")}
                </span>
              </dd>
              <dt>Tailnet</dt>
              <dd>{tail?.tailnet || "—"}</dd>
              <dt>{t("Node")}</dt>
              <dd>{tail?.hostname || "ztail"}</dd>
              <dt>{t("Console HTTPS address")}</dt>
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
                  t("Loading…")
                ) : tail.state !== "Running" ? (
                  t("Available after connecting")
                ) : !tail.magicDns || !tail.https ? (
                  t("Enable MagicDNS and HTTPS")
                ) : tail.panelError ? (
                  t("Temporarily unavailable; retrying")
                ) : (
                  t("Preparing the HTTPS endpoint…")
                )}
              </dd>
              <dt>{t("Configured tag")}</dt>
              <dd className="mono">{config?.nodeTag}</dd>
              <dt>{t("Assigned tags")}</dt>
              <dd className="mono">
                {tail?.tags?.join(", ") || t("No tag assigned yet")}
              </dd>
              <dt>MagicDNS / HTTPS</dt>
              <dd>
                {tail?.magicDns ? t("Enabled") : t("Unconfirmed")} /{" "}
                {tail?.https ? t("Enabled") : t("Unconfirmed")}
              </dd>
              <dt>API Key</dt>
              <dd>
                {config?.apiKeyConfigured
                  ? t("Configured · Permissions checked on publish")
                  : t("Not configured · Bind existing Services")}
              </dd>
            </dl>
            <ErrorBox message={tail?.errorInfo || tail?.error || ""} />
            <ErrorBox
              message={
                tail?.panelError
                  ? t("Console HTTPS endpoint: ") +
                    message(tail.panelErrorInfo || tail.panelError)
                  : ""
              }
            />
            {healthWarnings.length ? (
              <div className="notice" role="status">
                {t("Tailscale health warning: ")}
                {healthWarnings.join("; ")}
              </div>
            ) : null}
            <ErrorBox
              message={
                message(error) !== message(tail?.errorInfo || tail?.error || "")
                  ? error
                  : ""
              }
            />
            {tail?.state === "NeedsMachineAuth" && (
              <div className="notice">
                {t("This node has joined and is awaiting admin approval.")}
                <a
                  href="https://login.tailscale.com/admin/machines"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("Open node management")}
                </a>
              </div>
            )}
            {tail &&
              tail.state !== "Running" &&
              tail.state !== "NeedsMachineAuth" && (
                <div className="auth-controls">
                  <p className="help">
                    {t(
                      "Save the merged policy above before starting authorization.",
                    )}
                  </p>
                  <button
                    className="primary"
                    disabled={busy || !config}
                    aria-busy={interactivePending}
                    onClick={() => void connect("interactive")}
                  >
                    {interactivePending ? <Busy /> : <ArrowUpRight size={16} />}
                    {interactivePending
                      ? browserPending
                        ? t("Waiting for authorization…")
                        : t("Getting authorization URL…")
                      : t("Interactive authorization")}
                  </button>
                  {interactivePending && (
                    <p className="help" role="status">
                      {browserPending
                        ? t(
                            "Complete authorization on the Tailscale page. ztail is waiting for connection confirmation.",
                          )
                        : t(
                            "Getting the authorization URL; it will open automatically when ready.",
                          )}
                    </p>
                  )}
                  {visibleAuthUrl &&
                    !tail?.connecting &&
                    tail?.connectMethod === "authkey" && (
                      <p className="help">
                        {t(
                          "Tailscale still requires web authorization. Open the link below to complete it, or retry with a valid Auth Key that can assign the node tag.",
                        )}
                      </p>
                    )}
                  {openNotice && (
                    <div className="notice" role="status">
                      {message(openNotice)}
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
                        {t("Open Tailscale authorization")}
                        <ArrowUpRight size={15} />
                      </a>
                    )}
                  <p className="help">
                    {t(
                      "Wait for the authorization URL and open it in a new tab. The authorizing account must be allowed to assign the configured tag. Status updates automatically when complete.",
                    )}
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void connect("authkey");
                    }}
                  >
                    <label htmlFor="auth-key">{t("Or use an Auth Key")}</label>
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
                      {keyPending && <Busy />}
                      {t("Join with an Auth Key")}
                    </button>
                    {keyPending && (
                      <p className="help" role="status">
                        {t(
                          "Joining with an Auth Key; waiting for Tailscale confirmation…",
                        )}
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
          <summary>{t("Access policy and merge fragment")}</summary>
          <p className="help">
            {t(
              "The node is connected. Expand this section when you need to adjust permissions.",
            )}
          </p>
          {policyGuide}
        </details>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
