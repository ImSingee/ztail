import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

export type Locale = "en" | "zh-CN" | "zh-TW";
export const localeStorageKey = "ztail.locale";
type Dictionary = Record<keyof typeof en, string>;
const dictionaries: Record<Locale, Dictionary> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};
export type MessageInfo = { key: string; args?: Message[]; action?: "policy" };
export type Message = string | number | MessageInfo;
export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN" || value === "zh-TW";
}
export function systemLocale(language: string): Locale {
  const parts = language.toLowerCase().split(/[-_]/);
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hant")) return "zh-TW";
  if (parts.includes("hans")) return "zh-CN";
  return parts.some((p) => ["tw", "hk", "mo"].includes(p)) ? "zh-TW" : "zh-CN";
}
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (isLocale(saved)) return saved;
  } catch {
    /* Language switching still works when storage is unavailable. */
  }
  return systemLocale(navigator.languages?.[0] || navigator.language || "en");
}
export class LocalizedError extends Error {
  constructor(public info: Message) {
    super(typeof info === "object" ? info.key : String(info));
  }
}
export function asMessage(error: unknown): Message {
  return error instanceof LocalizedError
    ? error.info
    : {
        key: "Operation failed: {0}",
        args: [error instanceof Error ? error.message : String(error)],
      };
}
// API messages use positional arguments. Technical values are data, never dictionary keys.
function renderMessage(locale: Locale, value: Message): string {
  const info = typeof value === "object" ? value : { key: String(value) };
  const dictionary = dictionaries[locale] as Record<string, string>;
  const text = dictionary[info.key] ?? info.key;
  return text.replace(/\{(\d+)\}/g, (token, index) => {
    const arg = info.args?.[Number(index)];
    return arg === undefined
      ? token
      : typeof arg === "object"
        ? renderMessage(locale, arg)
        : String(arg);
  });
}
type I18n = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, ...args: Message[]) => string;
  message: (value: Message) => string;
};
const Context = createContext<I18n | null>(null);
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, update] = useState(initialLocale);
  const setLocale = (value: Locale) => {
    update(value);
    try {
      localStorage.setItem(localeStorageKey, value);
    } catch {
      /* Keep in-memory preference. */
    }
  };
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = renderMessage(locale, "ztail · Service publishing");
  }, [locale]);
  const t = (key: string, ...args: Message[]) =>
    renderMessage(locale, { key, args });
  return (
    <Context.Provider
      value={{
        locale,
        setLocale,
        t,
        message: (value) => renderMessage(locale, value),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error("I18nProvider is required");
  return value;
}
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      className="language-switcher"
      aria-label={t("Language")}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      <option value="en" lang="en">
        English
      </option>
      <option value="zh-CN" lang="zh-CN">
        简体中文
      </option>
      <option value="zh-TW" lang="zh-TW">
        繁體中文
      </option>
    </select>
  );
}
// Rich translations interpolate React elements without allowing HTML from resources.
export function RichText({ id, values }: { id: string; values: ReactNode[] }) {
  const { t } = useI18n();
  return (
    <>
      {t(id)
        .split(/(\{\d+\})/g)
        .map((part, index) => (
          <span key={index}>
            {/^\{\d+\}$/.test(part) ? values[Number(part.slice(1, -1))] : part}
          </span>
        ))}
    </>
  );
}
