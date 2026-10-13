import { useI18n, asMessage, type Message } from "./i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { Config, Rule, Tail } from "./main";
import { accessPreview, publicPort, rulePolicy } from "./rule-helpers";

export function PolicyError({
  message: value,
  onOpen,
}: {
  message: Message;
  onOpen: () => void;
}) {
  const { t, message } = useI18n();
  return (
    <>
      {message(value)}
      {typeof value === "object" && value.action === "policy" && (
        <>
          {" "}
          <button type="button" className="policy-link" onClick={onOpen}>
            {t("Configure access policy")}
          </button>
        </>
      )}
    </>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const { t, message } = useI18n();
  const [copied, setCopied] = useState(false),
    [error, setError] = useState<Message>("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        aria-label={t("Copy {0}", label)}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError("");
          } catch {
            setError("Copy failed. Select the content and copy it manually.");
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? t("Copied") : t("Copy")}
      </button>
      {error && (
        <span className="row-error" role="alert">
          {message(error)}
        </span>
      )}
    </>
  );
}

function useModalDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return dialog;
}

function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
  const first = controls[0],
    last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

export function PolicyGuide({
  rule,
  config,
  tail,
  onClose,
  onRetry,
}: {
  rule: Rule;
  config: Config | null;
  tail: Tail | null;
  onClose: () => void;
  onRetry: () => Promise<void>;
}) {
  const { t, message } = useI18n();
  const dialog = useModalDialog();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Message>("");
  const policy = config
    ? JSON.stringify(rulePolicy(config, rule), null, 2)
    : "";
  const port = publicPort(rule);
  return (
    <dialog
      ref={dialog}
      className="policy-guide"
      aria-labelledby="policy-guide-title"
      aria-describedby="policy-guide-description"
      onKeyDown={trapDialogFocus}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="policy-guide-heading">
        <h2 id="policy-guide-title">
          {t("Configure access policy for {0}", rule.name)}
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Close configuration guide")}
          autoFocus
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <p id="policy-guide-description" className="muted">
        {t(
          "Complete these steps in the Tailscale console, then return to ztail and retry publishing.",
        )}
      </p>
      {!config ? (
        <div className="loading-inline">
          <LoaderCircle className="spin" size={16} />
          {t("Loading configuration…")}
        </div>
      ) : (
        <>
          <section className="guide-step">
            <div className="guide-step-heading">
              <h3>{t("1. Define a Tailscale Service")}</h3>
              <a
                href="https://console.tailscale.com/admin/services"
                target="_blank"
                rel="noreferrer"
              >
                {t("Open Services")}
                <ArrowUpRight size={14} />
              </a>
            </div>
            <p>
              {t("Choose Define a Service, enter the values below and save.")}
            </p>
            <div className="guide-fields">
              <label htmlFor="guide-service-name">Service name</label>
              <div className="guide-field">
                <input id="guide-service-name" readOnly value={rule.name} />
                <CopyValue value={rule.name} label="Service name" />
              </div>
              <label htmlFor="guide-service-port">Ports</label>
              <div className="guide-field">
                <div className="guide-port">
                  <span>tcp:</span>
                  <input id="guide-service-port" readOnly value={port} />
                </div>
                <CopyValue value={String(port)} label="Ports" />
              </div>
              <label htmlFor="guide-service-tag">Service tags</label>
              <div className="guide-field">
                <input
                  id="guide-service-tag"
                  readOnly
                  value={config.serviceTag}
                />
                <CopyValue value={config.serviceTag} label="Service tags" />
              </div>
            </div>
            <p className="help">
              {t(
                "If Ports already shows tcp: on the left, enter only {0}. This is the tailnet {1} endpoint; ztail forwards to backend port {2}.",
                port,
                rule.protocol === "tcp" ? "TCP" : "HTTPS",
                rule.port,
              )}
            </p>
            <p className="help">
              {t(
                "Assign this Service the tag {0}; the ztail node uses {1}.",
                config.serviceTag,
                config.nodeTag,
              )}
            </p>
            <div className="guide-domain mono">
              {accessPreview(rule, tail?.dnsSuffix, t("<name>"))}
            </div>
          </section>
          <section className="guide-step">
            <div className="guide-step-heading">
              <h3>{t("2. Merge approval and access rules")}</h3>
              <a
                href="https://console.tailscale.com/admin/acls"
                target="_blank"
                rel="noreferrer"
              >
                {t("Open Access controls")}
                <ArrowUpRight size={14} />
              </a>
            </div>
            <p>
              {t(
                "Merge the fragment below into your existing policy, keeping other rules. It allows nodes tagged {0} to host these services, and the listed sources to access {1} {2}.",
                config.nodeTag,
                rule.protocol === "tcp" ? "TCP" : "HTTPS",
                port,
              )}
            </p>
            <p className="help">
              {t(
                "If tagOwners, autoApprovers or grants already exist, merge their entries. Use the same member / members selector spelling as your existing policy; do not mix them.",
              )}
            </p>
            <div className="guide-policy">
              <CopyValue value={policy} label={t("Policy fragment")} />
              <pre aria-label={t("Tailscale policy fragment")} tabIndex={0}>
                {policy}
              </pre>
            </div>
          </section>
          <section className="guide-step">
            <h3>{t("3. Retry publishing and check approval")}</h3>
            <p>
              {t(
                "Save, then return to ztail and retry. If Service hosts shows pending approval, approve the ztail node. Eligible advertisements are approved automatically when the rules above are enabled.",
              )}
            </p>
            <p className="help">
              {t(
                "Ensure MagicDNS is enabled. {0} You save the policy in the Tailscale console; ztail provides this guide.",
                {
                  key:
                    rule.protocol === "tcp"
                      ? "TCP does not need an HTTPS certificate."
                      : "Web services also require HTTPS.",
                },
              )}
            </p>
          </section>
        </>
      )}
      {error && (
        <div className="notice error" role="alert">
          {message(error)}
        </div>
      )}
      <div className="guide-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {t("Close")}
        </button>
        {rule.enabled && (
          <button
            type="button"
            className="primary"
            disabled={busy || !config}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onRetry();
                onClose();
              } catch (e) {
                setError(asMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            {t("Retry publishing")}
          </button>
        )}
      </div>
    </dialog>
  );
}

export function PublishedAccessHelp({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useModalDialog();
  return (
    <dialog
      ref={dialog}
      className="policy-guide access-help"
      aria-labelledby="access-help-title"
      aria-describedby="access-help-description"
      onKeyDown={trapDialogFocus}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="policy-guide-heading">
        <h2 id="access-help-title">{t("Can't access a published service?")}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Close access help")}
          autoFocus
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <p id="access-help-description" className="muted">
        {t(
          "Published means ztail advertises that it hosts the service. Before connecting, check host approval and access permissions for the published port.",
        )}
      </p>
      <section className="guide-step">
        <div className="guide-step-heading">
          <h3>{t("1. Check service host approval")}</h3>
          <a
            href="https://console.tailscale.com/admin/services"
            target="_blank"
            rel="noreferrer"
          >
            {t("Open Services")}
            <ArrowUpRight size={14} />
          </a>
        </div>
        <p>
          {t(
            "If you merged ztail's automatic approval policy and the node and Service tags match, the service host is approved automatically. Otherwise, open the corresponding Service in the Tailscale console and approve the hosting ztail node under Service hosts.",
          )}
        </p>
      </section>
      <section className="guide-step">
        <h3>{t("2. Wait for the first HTTPS certificate")}</h3>
        <p>
          {t(
            "Web services need Tailscale to issue a certificate for their HTTPS hostname. Initial issuance may take several minutes. If you just published, wait before opening the address. TCP services do not need an HTTPS certificate; connect to the displayed hostname and published port with the appropriate client.",
          )}
        </p>
      </section>
      <div className="guide-actions">
        <button type="button" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
    </dialog>
  );
}
