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

export function PolicyError({
  message,
  onOpen,
}: {
  message: string;
  onOpen: () => void;
}) {
  const text = "配置访问策略";
  const position = message.indexOf(text);
  if (position < 0) return <>{message}</>;
  return (
    <>
      {message.slice(0, position)}
      <button type="button" className="policy-link" onClick={onOpen}>
        {text}
      </button>
      {message.slice(position + text.length)}
    </>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        aria-label={"复制 " + label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError("");
          } catch {
            setError("复制失败，请选择内容手动复制。");
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? "已复制" : "复制"}
      </button>
      {error && (
        <span className="row-error" role="alert">
          {error}
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
  const dialog = useModalDialog();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const policy = config ? JSON.stringify(config.policy, null, 2) : "";
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
        <h2 id="policy-guide-title">配置 {rule.name} 的访问策略</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭配置指南"
          autoFocus
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <p id="policy-guide-description" className="muted">
        在 Tailscale 控制台完成以下配置，再回到 ztail 重试发布。
      </p>
      {!config ? (
        <div className="loading-inline">
          <LoaderCircle className="spin" size={16} />
          正在读取配置…
        </div>
      ) : (
        <>
          <section className="guide-step">
            <div className="guide-step-heading">
              <h3>1. 定义 Tailscale Service</h3>
              <a
                href="https://console.tailscale.com/admin/services"
                target="_blank"
                rel="noreferrer"
              >
                打开 Services
                <ArrowUpRight size={14} />
              </a>
            </div>
            <p>选择 Define a Service，按下面的值填写表单并保存。</p>
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
                  <input id="guide-service-port" readOnly value="443" />
                </div>
                <CopyValue value="443" label="Ports" />
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
              Ports 左侧已有 tcp: 时，只填 443。这里是 tailnet HTTPS
              入口；后端端口 {rule.port} 继续由 ztail 转发。
            </p>
            <p className="help">
              给这条 Service 选择 <code>{config.serviceTag}</code>；ztail
              节点使用 <code>{config.nodeTag}</code>。
            </p>
            <div className="guide-domain mono">
              https://{rule.name}.{tail?.dnsSuffix || "<tailnet>.ts.net"}
            </div>
          </section>
          <section className="guide-step">
            <div className="guide-step-heading">
              <h3>2. 合并审批和访问规则</h3>
              <a
                href="https://console.tailscale.com/admin/acls"
                target="_blank"
                rel="noreferrer"
              >
                打开 Access controls
                <ArrowUpRight size={14} />
              </a>
            </div>
            <p>
              将以下片段合并到已有策略，保留其它规则。它允许带{" "}
              <code>{config.nodeTag}</code>{" "}
              的节点承载这组服务，并允许所列来源访问 HTTPS 443。
            </p>
            <p className="help">
              已有 tagOwners、autoApprovers 或 grants
              时，合并其中的条目。成员选择器 member / members
              的写法应与现有策略一致，不能混用。
            </p>
            <div className="guide-policy">
              <CopyValue value={policy} label="策略片段" />
              <pre aria-label="Tailscale 策略片段" tabIndex={0}>
                {policy}
              </pre>
            </div>
          </section>
          <section className="guide-step">
            <h3>3. 重试发布并检查审批</h3>
            <p>
              保存后回到 ztail 重试。如果 Service hosts 显示待审批，请批准 ztail
              节点。启用上述自动审批规则后，符合条件的广告会自动批准。
            </p>
            <p className="help">
              确认 tailnet 已开启 MagicDNS 和 HTTPS。ztail
              提供配置指南，策略由你在 Tailscale 控制台保存。
            </p>
          </section>
        </>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="guide-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          关闭
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
                setError((e as Error).message);
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
            重试发布
          </button>
        )}
      </div>
    </dialog>
  );
}

export function PublishedAccessHelp({ onClose }: { onClose: () => void }) {
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
        <h2 id="access-help-title">无法访问已发布的规则？</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭访问帮助"
          autoFocus
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      <p id="access-help-description" className="muted">
        已广告表示 ztail 已声明承载服务。访问 HTTPS 地址前，请确认以下两点。
      </p>
      <section className="guide-step">
        <div className="guide-step-heading">
          <h3>1. 确认服务主机已获审批</h3>
          <a
            href="https://console.tailscale.com/admin/services"
            target="_blank"
            rel="noreferrer"
          >
            打开 Services <ArrowUpRight size={14} />
          </a>
        </div>
        <p>
          如果已合并 ztail
          提供的自动审批策略，且节点与服务的标签匹配，服务主机会自动获批。
          否则，请在 Tailscale 控制台打开对应的 Service，在 Service hosts
          中手动批准承载它的 ztail 节点。
        </p>
      </section>
      <section className="guide-step">
        <h3>2. 等待首次 HTTPS 证书签发</h3>
        <p>
          新发布的服务需要由 Tailscale 为其 HTTPS
          域名签发证书，首次签发可能需要数分钟。
          如果刚刚发布，请稍候再打开访问地址。
        </p>
      </section>
      <div className="guide-actions">
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
    </dialog>
  );
}
