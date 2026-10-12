import { useI18n, asMessage, type Message } from "./i18n";
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
import {
  accessPreview,
  connectionAddress,
  isWebAddress,
  publicPort,
} from "./rule-helpers";

const supportedPort = (p: ServicePort) =>
  ["HTTP", "HTTPS", "TCP"].includes(p.type.toUpperCase()) &&
  p.port > 0 &&
  p.port <= 65535;
const protocol = (p: ServicePort): Rule["protocol"] =>
  p.type.toUpperCase() === "TCP"
    ? "tcp"
    : p.type.toUpperCase() === "HTTPS"
      ? "https"
      : "http";
const deploymentStates: Record<string, string> = {
  RUNNING: "Running",
  STOPPED: "Stopped",
  SUSPENDED: "Suspended",
  NOT_DEPLOYED: "Not deployed",
  BUILDING: "Building",
  DEPLOYING: "Deploying",
  FAILED: "Deployment failed",
  CRASHED: "Crashed",
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
    publishPort: port && protocol(port) === "tcp" ? port.port : 443,
    enabled: false,
    createService: !!config?.apiKeyConfigured,
    revision: 0,
    updatedAt: "",
  };
}
function ID({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <span className="resource-id mono">
      <span>{value}</span>
      <button
        className="icon-button"
        aria-label={t("Copy ID ") + value}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            window.prompt(t("Copy this ID"), value);
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
  const { t, message, locale } = useI18n();
  const { catalog, config, tail, onRefresh, onConfigure, onSettings } = props;
  const [search, setSearch] = useState(""),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState<Message>("");
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
            (k, d) => k + d.ports.filter(supportedPort).length,
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
          <h1>{t("Zeabur services")}</h1>
          <p className="muted">
            {t(
              "Browse cluster services and choose a port to publish to your tailnet.",
            )}
          </p>
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
              publishPort: 443,
              enabled: false,
              createService: false,
              revision: 0,
              updatedAt: "",
            })
          }
        >
          {t("Add a backend manually")}
        </button>
      </div>
      <div
        className="catalog-summary"
        aria-label={t("Service catalog statistics")}
      >
        <span>
          <Folder size={18} />
          <strong>{projects.length}</strong>{" "}
          {t(projects.length === 1 ? "Project" : "Projects")}
        </span>
        <span>
          <Cloud size={18} />
          <strong>{services}</strong>{" "}
          {t(services === 1 ? "Service" : "Services")}
        </span>
        <span>
          <Globe size={18} />
          <strong>{ports}</strong> {t("Publishable ports")}
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
          {tail?.state === "Running" ? tail.tailnet : t("Connect Tailscale")}
          <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="catalog-toolbar">
        <div>
          <h2>{t("Projects and services")}</h2>
          <span className="muted">
            {t("Grouped by project and environment")}
          </span>
        </div>
        <div className="catalog-tools">
          <label className="catalog-search">
            <Search size={17} />
            <input
              aria-label={t("Search Zeabur services")}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search by name, DNS, ID or port")}
            />
          </label>
          <button
            aria-label={t("Refresh service catalog")}
            title={t("Refresh service catalog")}
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              setError("");
              try {
                await onRefresh();
              } catch (e) {
                setError(asMessage(e));
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCw size={16} className={refreshing ? "spin" : ""} />
            <span>{t("Refresh")}</span>
          </button>
        </div>
      </div>
      {catalog?.updatedAt && (
        <p className="catalog-updated">
          {t("Updated ")}{" "}
          {new Date(catalog.updatedAt).toLocaleString(locale, {
            hour12: false,
          })}
        </p>
      )}
      {(error || catalog?.error) && (
        <div className="notice error" role="alert">
          {message(error || catalog?.errorInfo || catalog?.error || "")}
        </div>
      )}
      {!catalog || (!catalog.updatedAt && !catalog.error) ? (
        <div
          className="catalog-skeleton"
          aria-label={t("Loading service catalog")}
        >
          {[1, 2, 3].map((n) => (
            <div key={n} />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="empty">
          <Cloud size={34} />
          <h2>{t("No service catalog available for this server yet")}</h2>
          <p>
            {t(
              "Check the server configuration and API Key, or refresh the service catalog.",
            )}
          </p>
        </div>
      ) : groups.length === 0 ? (
        <div className="empty">
          <Search size={30} />
          <h2>{t("No matching services")}</h2>
          <p>{t("Try a service name, DNS name or port number.")}</p>
          <button onClick={() => setSearch("")}>{t("Clear search")}</button>
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
                      <span>
                        {t(
                          project.services.length === 1
                            ? "{0} service"
                            : "{0} services",
                          project.services.length,
                        )}
                      </span>
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
                            {t("Environment")}
                            <strong>{environment.name}</strong>
                          </span>
                          <ID value={environment._id} />
                        </div>
                        <div className="catalog-columns" aria-hidden="true">
                          <span>{t("Service / DNS")}</span>
                          <span>{t("Port")}</span>
                          <span>{t("Deployment status")}</span>
                          <span>{t("Actions")}</span>
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
        {t(
          "Ports come from the selected environment. HTTP/HTTPS and TCP support quick publishing; UDP is shown for reference. You can change the access name before publishing. Approval and access follow your tailnet policy.",
        )}
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
  const { t, message } = useI18n();
  const [draft, setDraft] = useState<Rule | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Message>("");
  const ports = details?.ports || [];
  const publishable =
    details && !details.error ? ports.filter(supportedPort) : [];
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
          <span className="mono muted">
            {service.dnsName || t("DNS not set")}
          </span>
          <ID value={service._id} />
        </div>
        <div className="catalog-ports">
          {ports.length ? (
            ports.map((p) => (
              <span
                className={"port-chip mono " + (supportedPort(p) ? "web" : "")}
                key={p.id + p.port}
              >
                {p.type} :{p.port}
              </span>
            ))
          ) : (
            <span className="muted">
              {details?.error ? t("Failed to load ports") : t("No ports found")}
            </span>
          )}
          {details?.error && (
            <span className="row-error">
              {message(details.errorInfo || details.error)}
              <br />
              {t("Showing previous data. Refresh to retry.")}
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
            {status
              ? t(deploymentStates[status] || status)
              : t("Unknown status")}
          </span>
          {details?.error && (
            <div className="status-note">{t("Data needs refresh")}</div>
          )}
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
                  ? t("Published")
                  : rule.enabled
                    ? t("Pending / Error")
                    : t("Configured")}
              </span>
              <button onClick={() => onManage(rule.id)}>
                {ports.filter(supportedPort).length > 1 ||
                serviceRules.length > 1
                  ? t("Manage {0}", rule.port)
                  : t("Manage publishing")}
              </button>
              {(rule.status.state === "advertised" || rule.status.activeUrl) &&
                (isWebAddress(rule.status.activeUrl || rule.status.url) ? (
                  <a
                    className="mono"
                    href={rule.status.activeUrl || rule.status.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {rule.name}
                    <ArrowUpRight size={12} />
                  </a>
                ) : (
                  <span className="mono">
                    {connectionAddress(
                      rule.status.activeUrl || rule.status.url,
                    )}
                  </span>
                ))}
              {rule.status.error && (
                <span className="row-error">
                  <PolicyError
                    message={rule.status.errorInfo || rule.status.error}
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
                aria-label={t(
                  "Publish {0} {1} · {2}",
                  service.name,
                  p.port,
                  environment.name,
                )}
                onClick={() => {
                  setError("");
                  setDraft(
                    draftFor(project, environment, service, p, rules, config),
                  );
                }}
              >
                {t("Publish")}
                {publishable.length > 1 ? " " + p.port : ""}
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
              {t("Configure manually")}
            </button>
          )}
        </div>
      </div>
      {draft && (
        <form
          className="quick-publish"
          aria-label={t("Publish ") + service.name + " · " + environment.name}
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || nameConflict || !selectionValid) return;
            setBusy(true);
            setError("");
            try {
              await onPublish({ ...draft, enabled: true });
              setDraft(null);
            } catch (e) {
              setError(asMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="quick-publish-heading">
            <strong>{t("Publish {0}", service.name)}</strong>
            <span>
              {environment.name} · {draft.protocol.toUpperCase()} :{draft.port}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Cancel quick publishing")}
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              <X size={16} />
            </button>
          </div>
          <label htmlFor={"publish-" + service._id + environment._id}>
            {t("Access name")}
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
              {accessPreview(draft, tail?.dnsSuffix, t("<name>"))}
            </span>
          </div>
          {draft.protocol === "tcp" && (
            <div className="field">
              <label htmlFor={"publish-port-" + service._id + environment._id}>
                {t("Published port")}
              </label>
              <input
                id={"publish-port-" + service._id + environment._id}
                type="number"
                min={1}
                max={65535}
                required
                disabled={busy}
                value={draft.publishPort}
                onChange={(e) =>
                  setDraft({ ...draft, publishPort: Number(e.target.value) })
                }
              />
              <p className="help">
                {t(
                  "Connect with the appropriate client; traffic forwards to backend port {0}. Test connectivity in the full configuration.",
                  draft.port,
                )}
              </p>
            </div>
          )}
          {nameConflict && (
            <p className="row-error" role="alert">
              {t("This name is already in use. Choose another name.")}
            </p>
          )}
          {!selectionValid && (
            <p className="row-error" role="alert">
              {t("Port data has expired. Refresh and select the port again.")}
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
              {t(
                "Create the Tailscale Service through the API if this name is not yet defined",
              )}
            </label>
          ) : (
            <p className="help">
              {t(
                "First define {0} ({1}) in the Tailscale console.",
                `svc:${draft.name || t("<name>")}`,
                `tcp:${publicPort(draft)}`,
              )}
            </p>
          )}
          {tail?.state !== "Running" && (
            <p className="help">
              {t(
                "The node is disconnected. You can save the service configuration; it will publish after connecting.",
              )}
              <button
                type="button"
                className="text-button"
                onClick={onSettings}
              >
                {t("Connection settings")}
              </button>
            </p>
          )}
          {error && (
            <div className="notice error" role="alert">
              {message(error)}
            </div>
          )}
          <div className="quick-publish-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => onConfigure(draft)}
            >
              {t("Full configuration")}
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
              {t("Publish to tailnet")}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
