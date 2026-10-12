import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  Folder,
  Globe,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
  X,
} from "lucide-react";
import type {
  Catalog,
  Config,
  Named,
  Project,
  Rule,
  RuleView,
  ServiceEnvironment,
  ServicePort,
  Tail,
  ZeaburService,
} from "./main";
import { PolicyError } from "./policy-guide";

const webPort = (p: ServicePort) =>
  ["HTTP", "HTTPS"].includes(p.type.toUpperCase()) &&
  p.port > 0 &&
  p.port <= 65535;
const protocol = (p: ServicePort): Rule["protocol"] =>
  p.type.toUpperCase() === "HTTPS" ? "https" : "http";
const deploymentStates: Record<string, string> = {
  RUNNING: "运行中",
  STOPPED: "已停止",
  SUSPENDED: "已暂停",
  NOT_DEPLOYED: "未部署",
  BUILDING: "构建中",
  DEPLOYING: "部署中",
  FAILED: "部署失败",
  CRASHED: "已崩溃",
};

function suggestedName(service: ZeaburService, rules: RuleView[]) {
  const base =
    (service.dnsName || service.name)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63)
      .replace(/-+$/g, "") || "service";
  const used = new Set(rules.map((r) => r.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = "-" + i;
    const name = base.slice(0, 63 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!used.has(name)) return name;
  }
}
function draftFor(
  project: Project,
  environment: Named,
  service: ZeaburService,
  port: ServicePort | undefined,
  rules: RuleView[],
  config: Config | null,
): Rule {
  return {
    id: "",
    name: suggestedName(service, rules),
    source: "zeabur",
    projectId: project._id,
    environmentId: environment._id,
    serviceId: service._id,
    host: "",
    protocol: port ? protocol(port) : "http",
    port: port?.port || 0,
    enabled: false,
    createService: !!config?.apiKeyConfigured,
    revision: 0,
    updatedAt: "",
  };
}
function ID({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="resource-id mono">
      <span>{value}</span>
      <button
        className="icon-button"
        aria-label={"复制 ID " + value}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            window.prompt("复制此 ID", value);
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </span>
  );
}

type Props = {
  catalog: Catalog | null;
  config: Config | null;
  tail: Tail | null;
  rules: RuleView[];
  onRefresh: () => Promise<void>;
  onPublish: (rule: Rule) => Promise<Rule>;
  onConfigure: (rule: Rule) => void;
  onManage: (id: string) => void;
  onSettings: () => void;
  onPolicy: (rule: Rule) => void;
};

export function ServiceCatalog(props: Props) {
  const { catalog, config, tail, rules, onRefresh, onConfigure, onSettings } =
    props;
  const [search, setSearch] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState("");
  const projects = catalog?.projects || [];
  const term = search.trim().toLowerCase();
  const groups = projects
    .map((project) => ({
      project,
      environments: project.environments
        .map((environment) => ({
          environment,
          services: project.services.filter((service) => {
            const details = service.environments?.[environment._id];
            return [
              project.name,
              project._id,
              environment.name,
              environment._id,
              service.name,
              service.dnsName,
              service._id,
              ...(details?.ports || []).map((p) => `${p.type} ${p.port}`),
            ]
              .join(" ")
              .toLowerCase()
              .includes(term);
          }),
        }))
        .filter((group) => group.services.length),
    }))
    .filter((group) => group.environments.length);
  const services = projects.reduce((n, p) => n + p.services.length, 0);
  const ports = projects.reduce(
    (n, p) =>
      n +
      p.services.reduce(
        (m, s) =>
          m +
          Object.values(s.environments || {}).reduce(
            (k, d) => k + d.ports.filter(webPort).length,
            0,
          ),
        0,
      ),
    0,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Zeabur 服务</h1>
          <p className="muted">浏览集群服务，选择端口发布到 tailnet。</p>
        </div>
        <button
          onClick={() =>
            onConfigure({
              id: "",
              name: "",
              source: "manual",
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
            })
          }
        >
          手动添加后端
        </button>
      </div>
      <div className="catalog-summary" aria-label="服务目录统计">
        <span>
          <Folder size={18} />
          <strong>{projects.length}</strong> 项目
        </span>
        <span>
          <Cloud size={18} />
          <strong>{services}</strong> 服务
        </span>
        <span>
          <Globe size={18} />
          <strong>{ports}</strong> Web 端口
        </span>
      </div>
      <div className="catalog-server">
        <div>
          <Server size={17} />
          <strong>{catalog?.server.name || "Dedicated Server"}</strong>
          <ID value={catalog?.server._id || config?.serverId || "…"} />
        </div>
        <button className="text-button" onClick={onSettings}>
          <span
            className={"dot " + (tail?.state === "Running" ? "green" : "amber")}
          />
          {tail?.state === "Running" ? tail.tailnet : "连接 Tailscale"}
          <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="catalog-toolbar">
        <div>
          <h2>项目与服务</h2>
          <span className="muted">按项目与环境分组</span>
        </div>
        <div className="catalog-tools">
          <label className="catalog-search">
            <Search size={17} />
            <input
              aria-label="搜索 Zeabur 服务"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索名称、DNS、ID 或端口"
            />
          </label>
          <button
            aria-label="刷新服务列表"
            title="刷新服务列表"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              setError("");
              try {
                await onRefresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw size={16} className={refreshing ? "spin" : ""} />
            <span>刷新</span>
          </button>
        </div>
      </div>
      {catalog?.updatedAt && (
        <p className="catalog-updated">
          更新于{" "}
          {new Date(catalog.updatedAt).toLocaleString("zh-CN", {
            hour12: false,
          })}
        </p>
      )}
      {(error || catalog?.error) && (
        <div className="notice error" role="alert">
          {error || catalog?.error}
        </div>
      )}
      {!catalog || (!catalog.updatedAt && !catalog.error) ? (
        <div className="catalog-skeleton" aria-label="正在读取服务目录">
          {[1, 2, 3].map((n) => (
            <div key={n} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="empty">
          <Cloud size={34} />
          <h2>此服务器还没有可用的服务目录</h2>
          <p>检查服务器配置和 API Key，或刷新服务列表。</p>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <Search size={30} />
          <h2>没有匹配的服务</h2>
          <p>试试服务名称、DNS 或端口号。</p>
          <button onClick={() => setSearch("")}>清除搜索</button>
        </div>
      ) : (
        <div className="catalog-groups">
          {groups.map(({ project, environments }) => {
            const open = !!term || !collapsed.has(project._id);
            return (
              <section className="catalog-project" key={project._id}>
                <div className="catalog-project-heading">
                  <h2>
                    <button
                      aria-expanded={open}
                      aria-controls={"project-" + project._id}
                      onClick={() =>
                        setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(project._id)) next.delete(project._id);
                          else next.add(project._id);
                          return next;
                        })
                      }
                    >
                      <ChevronDown size={17} className={open ? "" : "closed"} />
                      {project.name}
                      <span>{project.services.length} 个服务</span>
                    </button>
                  </h2>
                  <ID value={project._id} />
                </div>
                {open && (
                  <div id={"project-" + project._id}>
                    {environments.map(({ environment, services }) => (
                      <section
                        className="catalog-environment"
                        key={environment._id}
                        aria-label={project.name + " / " + environment.name}
                      >
                        <div className="catalog-environment-heading">
                          <span>
                            环境 <strong>{environment.name}</strong>
                          </span>
                          <ID value={environment._id} />
                        </div>
                        <div className="catalog-columns" aria-hidden="true">
                          <span>服务 / DNS</span>
                          <span>端口</span>
                          <span>部署状态</span>
                          <span>操作</span>
                        </div>
                        {services.map((service) => (
                          <ServiceRow
                            {...props}
                            key={service._id}
                            project={project}
                            environment={environment}
                            service={service}
                            details={service.environments?.[environment._id]}
                          />
                        ))}
                      </section>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="footnote">
        端口来自所选环境。HTTP/HTTPS 支持快捷发布；TCP/UDP
        展示供参考。发布前可修改访问名称，审批和访问权限遵循 tailnet 策略。
      </p>
    </>
  );
}

function ServiceRow({
  project,
  environment,
  service,
  details,
  config,
  tail,
  rules,
  onPublish,
  onConfigure,
  onManage,
  onSettings,
  onPolicy,
}: Props & {
  project: Project;
  environment: Named;
  service: ZeaburService;
  details?: ServiceEnvironment;
}) {
  const [draft, setDraft] = useState<Rule | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ports = details?.ports || [];
  const publishable = details && !details.error ? ports.filter(webPort) : [];
  const status = details?.status;
  const serviceRules = rules.filter(
    (r) =>
      r.source === "zeabur" &&
      r.projectId === project._id &&
      r.environmentId === environment._id &&
      r.serviceId === service._id,
  );
  const matching = (port: ServicePort) =>
    serviceRules.find(
      (r) => r.port === port.port && r.protocol === protocol(port),
    );
  const nameConflict = !!draft && rules.some((r) => r.name === draft.name);
  const selectionValid =
    !!draft &&
    !details?.error &&
    publishable.some(
      (p) => p.port === draft.port && protocol(p) === draft.protocol,
    );
  return (
    <article
      className="catalog-service"
      aria-label={service.name + " · " + environment.name}
    >
      <div className="catalog-service-row">
        <div className="catalog-service-name">
          <strong>{service.name}</strong>
          <span className="mono muted">{service.dnsName || "未设置 DNS"}</span>
          <ID value={service._id} />
        </div>
        <div className="catalog-ports">
          {ports.length ? (
            ports.map((p) => (
              <span
                className={"port-chip mono " + (webPort(p) ? "web" : "")}
                key={p.id + p.port}
              >
                {p.type} :{p.port}
              </span>
            ))
          ) : (
            <span className="muted">
              {details?.error ? "端口读取失败" : "未发现端口"}
            </span>
          )}
          {details?.error && (
            <span className="row-error">
              {details.error}
              <br />
              显示上次数据，刷新后重试。
            </span>
          )}
        </div>
        <div>
          <span
            className={
              "badge " +
              (status === "RUNNING" && !details?.error ? "success" : "neutral")
            }
          >
            {status ? deploymentStates[status] || status : "状态未知"}
          </span>
          {details?.error && <div className="status-note">数据待刷新</div>}
        </div>
        <div className="catalog-service-actions">
          {serviceRules.map((rule) => (
            <div className="catalog-managed" key={rule.id}>
              <span
                className={
                  "badge " +
                  (rule.status.state === "advertised"
                    ? "success"
                    : rule.status.error
                      ? "danger"
                      : "neutral")
                }
              >
                {rule.status.state === "advertised"
                  ? "已发布"
                  : rule.enabled
                    ? "待发布 / 异常"
                    : "已配置"}
              </span>
              <button onClick={() => onManage(rule.id)}>
                管理
                {ports.filter(webPort).length > 1 || serviceRules.length > 1
                  ? " " + rule.port
                  : "发布"}
              </button>
              {(rule.status.state === "advertised" ||
                rule.status.activeUrl) && (
                <a
                  className="mono"
                  href={rule.status.activeUrl || rule.status.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {rule.name}
                  <ArrowUpRight size={12} />
                </a>
              )}
              {rule.status.error && (
                <span className="row-error">
                  <PolicyError
                    message={rule.status.error}
                    onOpen={() => onPolicy(rule)}
                  />
                </span>
              )}
            </div>
          ))}
          {publishable
            .filter((p) => !matching(p))
            .map((p) => (
              <button
                className="primary"
                key={p.id + p.port}
                aria-label={
                  "发布 " +
                  service.name +
                  " " +
                  p.port +
                  " · " +
                  environment.name
                }
                onClick={() => {
                  setError("");
                  setDraft(
                    draftFor(project, environment, service, p, rules, config),
                  );
                }}
              >
                发布{publishable.length > 1 ? " " + p.port : ""}
              </button>
            ))}
          {!publishable.length && !serviceRules.length && (
            <button
              onClick={() =>
                onConfigure(
                  draftFor(
                    project,
                    environment,
                    service,
                    undefined,
                    rules,
                    config,
                  ),
                )
              }
            >
              手动配置
            </button>
          )}
        </div>
      </div>
      {draft && (
        <form
          className="quick-publish"
          aria-label={"发布 " + service.name + " · " + environment.name}
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || nameConflict || !selectionValid) return;
            setBusy(true);
            setError("");
            try {
              await onPublish({ ...draft, enabled: true });
              setDraft(null);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="quick-publish-heading">
            <strong>发布 {service.name}</strong>
            <span>
              {environment.name} · {draft.protocol.toUpperCase()} :{draft.port}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="取消快捷发布"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              <X size={16} />
            </button>
          </div>
          <label htmlFor={"publish-" + service._id + environment._id}>
            访问名称
          </label>
          <div className="quick-publish-fields">
            <input
              id={"publish-" + service._id + environment._id}
              value={draft.name}
              pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
              maxLength={63}
              required
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <span className="mono domain-preview">
              https://{draft.name || "<名称>"}.
              {tail?.dnsSuffix || "<tailnet>.ts.net"}
            </span>
          </div>
          {nameConflict && (
            <p className="row-error" role="alert">
              此名称已被使用，请使用另一个名称。
            </p>
          )}
          {!selectionValid && (
            <p className="row-error" role="alert">
              端口数据已失效，请刷新并重新选择端口。
            </p>
          )}
          {config?.apiKeyConfigured ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={draft.createService}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, createService: e.target.checked })
                }
              />
              名称尚未定义时，通过 API 创建 Tailscale Service
            </label>
          ) : (
            <p className="help">
              请先在 Tailscale 控制台定义{" "}
              <code>svc:{draft.name || "<名称>"}</code>（tcp:443）。
            </p>
          )}
          {tail?.state !== "Running" && (
            <p className="help">
              节点尚未连接。可以先保存服务配置，接入后会发布。
              <button
                type="button"
                className="text-button"
                onClick={onSettings}
              >
                连接设置
              </button>
            </p>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <div className="quick-publish-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => onConfigure(draft)}
            >
              完整配置
              <ArrowUpRight size={14} />
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busy || nameConflict || !selectionValid}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Globe size={16} />
              )}
              发布到 tailnet
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
