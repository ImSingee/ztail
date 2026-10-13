import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
export function buildID() {
  const paths = [
    "src/main.tsx",
    "src/catalog.tsx",
    "src/policy-guide.tsx",
    "src/i18n.tsx",
    "src/rule-helpers.ts",
    "src/style.css",
    ...readdirSync("src/locales")
      .sort()
      .map((file) => "src/locales/" + file),
    "../internal/ztail/manager.go",
    "../internal/ztail/tailnet.go",
    "../internal/ztail/messages.go",
    "../internal/ztail/http.go",
  ];
  const hash = createHash("sha256");
  paths.forEach((path) => hash.update(readFileSync(path)));
  return hash.digest("hex").slice(0, 12);
}
