import type { Config, Rule } from "./main";

export const publicPort = (rule: Rule) =>
  rule.publishPort || (rule.protocol === "tcp" ? rule.port : 443);

export const connectionAddress = (url: string) => url.replace(/^tcp:\/\//, "");
export const isWebAddress = (url: string) => /^https?:\/\//.test(url);

export function accessPreview(rule: Rule, suffix?: string) {
  const host = `${rule.name || "<名称>"}.${suffix || "<tailnet>.ts.net"}`;
  return rule.protocol === "tcp"
    ? `${host}:${publicPort(rule)}`
    : `https://${host}`;
}

export function rulePolicy(config: Config, rule: Rule) {
  return {
    ...config.policy,
    grants: config.policy.grants.map((grant) =>
      grant.dst.includes(config.serviceTag)
        ? { ...grant, ip: [`tcp:${publicPort(rule)}`] }
        : grant,
    ),
  };
}
