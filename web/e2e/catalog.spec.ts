import { test, expect, Page, APIRequestContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
const apiBase = "http://127.0.0.1:18090";
async function login(page: Page, base = "") {
  await page.goto(base + "/");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Zeabur 服务", exact: true }),
  ).toBeVisible();
}
async function audit(request: APIRequestContext, base = "") {
  return (await request.get(base + "/fixture/audit")).json();
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}
test.beforeEach(async ({ request }) => {
  for (const base of ["", apiBase]) await request.get(base + "/fixture/reset");
  const hash = createHash("sha256")
    .update(readFileSync("src/main.tsx"))
    .update(readFileSync("src/catalog.tsx"))
    .update(readFileSync("src/policy-guide.tsx"))
    .update(readFileSync("../internal/ztail/manager.go"))
    .update(readFileSync("../internal/ztail/tailnet.go"))
    .digest("hex")
    .slice(0, 12);
  const health = await (await request.get("/healthz")).json();
  expect(health.version).toBe("e2e-" + hash);
  writeFileSync(
    `${assets}/catalog-provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + hash,
        fixtures:
          "Zeabur/Tailnet control plane; production UI, HTTP, SQLite, manager and proxy",
      },
      null,
      2,
    ),
  );
});
test("catalogue groups environment ports, searches and retains directory on refresh error", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  const production = page.getByRole("article", {
    name: "Grafana · Production",
    exact: true,
  });
  const preview = page.getByRole("article", {
    name: "Grafana · Preview",
    exact: true,
  });
  await expect(production).toContainText("HTTP :3000");
  await expect(production).toContainText("TCP :9090");
  await expect(preview).toContainText("HTTP :4000");
  await expect(preview).toContainText("HTTPS :4443");
  await expect(
    page.getByRole("article", { name: "Redis · Production", exact: true }),
  ).toContainText("UDP :5353");
  await capture(page, "catalog-desktop");
  await page.getByRole("button", { name: "Monitoring 2 个服务" }).click();
  await expect(preview).not.toBeVisible();
  await page.getByLabel("搜索 Zeabur 服务").fill("4000");
  await expect(preview).toBeVisible();
  await expect(production).not.toBeVisible();
  await capture(page, "catalog-search");
  await page.getByLabel("搜索 Zeabur 服务").fill("no-match");
  await expect(
    page.getByRole("heading", { name: "没有匹配的服务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.getByRole("button", { name: "Monitoring 2 个服务" }).click();
  await request.get("/fixture/failure?kind=catalog");
  await page.getByRole("button", { name: "刷新服务列表" }).click();
  await expect(page.getByRole("alert").first()).toContainText("401");
  await expect(production).toContainText("HTTP :3000");
  await capture(page, "catalog-refresh-error");
  const before = await audit(request);
  expect(before.rules).toEqual([]);
  expect(before.ads).toEqual([]);
  writeFileSync(
    `${assets}/catalog-browse-audit.json`,
    JSON.stringify(before, null, 2),
  );
});
test("inline publishing uses the selected environment and port, manages existing rules and avoids name collision", async ({
  page,
  request,
}) => {
  await login(page, apiBase);
  await request.get(apiBase + "/fixture/authorize");
  await expect(
    page.getByRole("button", {
      name: "发布 Grafana 3000 · Production",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "发布 Grafana 3000 · Production",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("访问名称", { exact: true })).toHaveValue(
    "grafana",
  );
  await expect(
    page.getByText("https://grafana.fixture.ts.net", { exact: true }),
  ).toBeVisible();
  let before = await audit(request, apiBase);
  expect(before.rules).toEqual([]);
  expect(before.ads).toEqual([]);
  await capture(page, "catalog-inline-publish");
  await page
    .getByRole("button", { name: "发布到 tailnet", exact: true })
    .click();
  const production = page.getByRole("article", {
    name: "Grafana · Production",
    exact: true,
  });
  await expect(production.getByText("已发布", { exact: true })).toBeVisible();
  let published = await audit(request, apiBase);
  expect(published.rules).toHaveLength(1);
  expect(published.rules[0]).toMatchObject({
    name: "grafana",
    environmentId: "env-first",
    serviceId: "service-a",
    projectId: "project-a",
    port: 3000,
    protocol: "http",
    enabled: true,
    createService: true,
  });
  expect(published.ads).toEqual(["grafana"]);
  await page
    .getByRole("button", { name: "发布 Grafana 4443 · Preview", exact: true })
    .click();
  await expect(page.getByLabel("访问名称", { exact: true })).toHaveValue(
    "grafana-2",
  );
  await page.getByLabel("访问名称", { exact: true }).fill("grafana");
  await expect(
    page.getByRole("button", { name: "发布到 tailnet", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("此名称已有发布规则，请使用另一个名称。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("访问名称", { exact: true }).fill("preview-secure");
  await page.getByRole("button", { name: "完整配置", exact: true }).click();
  await expect(page.getByLabel("环境", { exact: true })).toHaveValue(
    "env-second",
  );
  await expect(page.getByLabel("后端端口", { exact: true })).toHaveValue(
    "4443",
  );
  await expect(page.getByLabel("后端协议", { exact: true })).toHaveValue(
    "https",
  );
  await page.getByRole("button", { name: "返回服务列表" }).click();
  await page
    .getByRole("button", { name: "发布 Grafana 4000 · Preview", exact: true })
    .click();
  await page.getByLabel("访问名称", { exact: true }).fill("preview-web");
  await page
    .getByRole("button", { name: "发布到 tailnet", exact: true })
    .click();
  const preview = page.getByRole("article", {
    name: "Grafana · Preview",
    exact: true,
  });
  await expect(preview.getByText("已发布", { exact: true })).toBeVisible();
  let both = await audit(request, apiBase);
  expect(both.rules).toHaveLength(2);
  expect(
    both.rules.find((r: { name: string }) => r.name === "preview-web"),
  ).toMatchObject({
    environmentId: "env-second",
    port: 4000,
    protocol: "http",
    enabled: true,
  });
  expect(both.ads.sort()).toEqual(["grafana", "preview-web"]);
  await capture(page, "catalog-published");
  await request.get(apiBase + "/fixture/failure?kind=ports");
  await expect(
    preview.getByText("端口详情读取失败", { exact: false }),
  ).toBeVisible();
  await expect(
    preview.getByRole("button", { name: "管理 4000", exact: true }),
  ).toBeVisible();
  await capture(page, "catalog-published-stale");
  await production
    .getByRole("button", { name: "管理发布", exact: true })
    .click();
  await expect(page.getByLabel("Service 名称", { exact: true })).toHaveValue(
    "grafana",
  );
  writeFileSync(
    `${assets}/catalog-publish-audit.json`,
    JSON.stringify({ before, published, both }, null, 2),
  );
});
test("non-Web and stale ports are explicit, stale open forms cannot publish and errors stay actionable", async ({
  page,
  request,
}) => {
  await login(page);
  const redis = page.getByRole("article", {
    name: "Redis · Production",
    exact: true,
  });
  await expect(redis.getByRole("button", { name: /发布/ })).toHaveCount(0);
  await redis.getByRole("button", { name: "手动配置", exact: true }).click();
  await expect(page.getByLabel("后端端口", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("环境", { exact: true })).toHaveValue(
    "env-first",
  );
  await page.getByRole("button", { name: "返回服务列表" }).click();
  await expect(
    page.getByRole("article", { name: "Redis · Preview", exact: true }),
  ).toContainText("未发现端口");
  await page
    .getByRole("button", { name: "发布 Grafana 4000 · Preview", exact: true })
    .click();
  await request.get("/fixture/failure?kind=ports");
  await expect(
    page.getByRole("button", { name: "发布到 tailnet", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("端口数据已失效，请刷新并重新选择端口。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "发布 Grafana 3000 · Production",
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, "catalog-stale-ports");
  const state = await audit(request);
  expect(state.rules).toEqual([]);
  expect(state.ads).toEqual([]);
  writeFileSync(
    `${assets}/catalog-ports-audit.json`,
    JSON.stringify(state, null, 2),
  );
});
test("catalogue and inline publisher work at 390px with keyboard selection", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await request.get("/fixture/authorize");
  await expect(
    page.getByRole("button", { name: "fixture-tailnet", exact: true }),
  ).toBeVisible();
  await capture(page, "catalog-mobile");
  await page.getByRole("button", { name: "Monitoring 2 个服务" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("article", { name: "Grafana · Production", exact: true }),
  ).not.toBeVisible();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", {
      name: "发布 Grafana 3000 · Production",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("访问名称", { exact: true })).toBeFocused();
  await capture(page, "catalog-mobile-publish");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "发布到 tailnet", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "Grafana · Production", exact: true })
      .getByText("已发布", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "catalog-mobile-published");
  writeFileSync(
    `${assets}/catalog-responsive-audit.json`,
    JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        keyboardSelection: true,
        noHorizontalOverflow: true,
        receiver: await audit(request),
      },
      null,
      2,
    ),
  );
});
