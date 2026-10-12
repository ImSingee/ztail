import { createHash } from "node:crypto";
import { test, expect, Page, APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}
async function login(page: Page) {
  await page.goto("/rules");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "发布规则", exact: true }),
  ).toBeVisible();
}
async function authorize(
  page: Page,
  request: APIRequestContext,
  base = "http://127.0.0.1:18080",
) {
  await request.get(base + "/fixture/authorize");
  await page.getByRole("link", { name: "连接设置", exact: true }).click();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
}
async function audit(
  request: APIRequestContext,
  base = "http://127.0.0.1:18080",
) {
  return (await request.get(base + "/fixture/audit")).json();
}
async function manual(page: Page, name = "grafana") {
  await page.getByRole("button", { name: "新增规则" }).click();
  await page.getByLabel("Service 名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "手填地址", exact: true }).click();
  await page.getByLabel("后端主机名或 IP").fill("127.0.0.1");
  await page.getByLabel("后端端口").fill("18082");
}
test.beforeEach(async ({ request }) => {
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
    `${assets}/provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + hash,
        source:
          "Go test binary compiled from this working tree; production Vite assets embedded",
        fixtures: "Zeabur/Tailnet control plane only; real SQLite/HTTP/proxy",
      },
      null,
      2,
    ),
  );
  await request.get("/fixture/reset");
  await request.get("http://127.0.0.1:18090/fixture/reset");
});
test("login rejects wrong password, protects management and supports logout", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByLabel("管理员密码", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("管理员密码错误");
  await capture(page, "login-error");
  expect((await request.get("/api/settings")).status()).toBe(401);
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("link", { name: "发布规则", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "发布规则", exact: true }),
  ).toBeVisible();
  await capture(page, "empty-rules");
  expect(
    (await page.request.post("/api/catalog/refresh", { data: {} })).status(),
  ).toBe(403);
  await page.getByRole("button", { name: "退出管理面板" }).click();
  await expect(
    page.getByRole("heading", { name: "登录服务发布面板" }),
  ).toBeVisible();
  writeFileSync(
    `${assets}/login-audit.json`,
    JSON.stringify(
      {
        unauthenticatedGET: 401,
        missingCSRF: 403,
        wrongPasswordVisible: true,
        logoutReturnsToLogin: true,
      },
      null,
      2,
    ),
  );
});
test("Zeabur selection keeps second environment, drafts never advertise and refresh error keeps catalog", async ({
  page,
  request,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新增规则" }).click();
  await page.getByLabel("Service 名称", { exact: true }).fill("preview");
  await page.getByLabel("项目", { exact: true }).selectOption("project-a");
  await page.getByLabel("环境", { exact: true }).selectOption("env-second");
  await page.getByLabel("服务", { exact: true }).selectOption("service-a");
  await page.getByLabel("后端端口").fill("3000");
  await capture(page, "zeabur-second-environment");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿 / 已停用", { exact: true })).toBeVisible();
  const state = await audit(request);
  expect(state.rules[0].environmentId).toBe("env-second");
  expect(state.ads).toEqual([]);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await request.get("/fixture/failure?kind=catalog");
  await page.getByRole("button", { name: "刷新目录" }).click();
  await expect(page.getByRole("alert").first()).toContainText("401");
  expect(await page.getByLabel("环境", { exact: true }).inputValue()).toBe(
    "env-second",
  );
  await capture(page, "catalog-error-retained");
  writeFileSync(`${assets}/catalog-audit.json`, JSON.stringify(state, null, 2));
});
test("interactive opens authorization tab; custom tag and policy stay visible", async ({
  page,
  request,
}) => {
  await login(page);
  await page.getByRole("link", { name: "连接设置", exact: true }).click();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  await popup.waitForURL("**/fixture/authorize");
  const state = await audit(request);
  expect(state.connects[0]).toEqual({
    method: "interactive",
    authKeyPresent: false,
  });
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "交互式授权" })).toHaveCount(0);
  await page.getByText("访问策略与合并片段", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("tag:custom-host");
  await capture(page, "connected-settings");
  await popup.close();
  writeFileSync(
    `${assets}/authorization-audit.json`,
    JSON.stringify(state, null, 2),
  );
});
test("manual publish routes real upstream; edits reuse listener; rename, withdrawal retry and delete", async ({
  page,
  request,
}) => {
  await login(page);
  await authorize(page, request);
  await page.getByRole("link", { name: "发布规则", exact: true }).click();
  await manual(page);
  await page.getByRole("button", { name: "测试后端连接" }).click();
  await expect(page.getByText("后端可达", { exact: true })).toBeVisible();
  await capture(page, "manual-editor");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("已广告", { exact: true })).toBeVisible();
  let before = await audit(request);
  expect(before.ads).toEqual(["grafana"]);
  let response = await request.get(before.addresses.grafana + "/initial");
  expect(await response.text()).toBe("fixture backend: /initial");
  await capture(page, "published-rules");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("已广告", { exact: true })).toBeVisible();
  let unchanged = await audit(request);
  expect(unchanged.addresses.grafana).toBe(before.addresses.grafana);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByLabel("Service 名称", { exact: true })
    .fill("undefined-service");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(
    page.getByText("更新失败 · 旧配置运行中", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("当前入口：https://grafana.fixture.ts.net", {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    await (await request.get(before.addresses.grafana + "/still-live")).text(),
  ).toBe("fixture backend: /still-live");
  await capture(page, "failed-rename");
  const failedRename = await audit(request);
  expect(failedRename.ads).toEqual(["grafana"]);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("Service 名称", { exact: true }).fill("renamed");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(
    page.getByRole("link", { name: "renamed", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await audit(request)).ads)
    .toEqual(["renamed"]);
  let renamed = await audit(request);
  expect(
    await (await request.get(renamed.addresses.renamed + "/renamed")).text(),
  ).toBe("fixture backend: /renamed");
  await request.get("/fixture/failure?kind=withdrawal");
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await expect(page.getByText("撤回待重试", { exact: true })).toBeVisible();
  await capture(page, "withdrawal-pending");
  await request.get("/fixture/failure?kind=withdrawal&enabled=false");
  await expect.poll(async () => (await audit(request)).ads).toEqual([]);
  await expect(page.getByText("草稿 / 已停用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除 renamed" }).click();
  await page.getByRole("button", { name: "删除规则", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "还没有发布规则" }),
  ).toBeVisible();
  writeFileSync(
    `${assets}/lifecycle-audit.json`,
    JSON.stringify(
      {
        before,
        unchanged,
        failedRename,
        renamed,
        afterDelete: await audit(request),
        upstreamInitial: "fixture backend: /initial",
        upstreamRenamed: "fixture backend: /renamed",
      },
      null,
      2,
    ),
  );
});
test("optional API creation and error retry have separate observable requests", async ({
  page,
  request,
}) => {
  const base = "http://127.0.0.1:18090";
  await page.goto(base);
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await authorize(page, request, base);
  await page.getByRole("link", { name: "发布规则", exact: true }).click();
  await manual(page, "brand-new");
  await page.getByLabel("名称尚未定义时，通过 API 创建 Service").check();
  await request.get(base + "/fixture/failure?kind=registry");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("发布失败", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "TAILSCALE_API_KEY 无效、已过期或没有当前 tailnet 的 Services 权限",
      { exact: true },
    ),
  ).toBeVisible();
  await capture(page, "api-error");
  let failed = await audit(request, base);
  expect(failed.ads).toEqual([]);
  await request.get(base + "/fixture/failure?kind=registry&enabled=false");
  await page.getByRole("button", { name: "重试 brand-new" }).click();
  await expect(page.getByText("已广告", { exact: true })).toBeVisible();
  let successful = await audit(request, base);
  expect(
    successful.registryCalls.some(
      (c: { create: boolean; name: string }) =>
        c.create && c.name === "brand-new",
    ),
  ).toBe(true);
  await capture(page, "api-created");
  writeFileSync(
    `${assets}/api-ui-audit.json`,
    JSON.stringify({ failed, successful }, null, 2),
  );
});
test("responsive surfaces and keyboard navigation do not overflow", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await capture(page, "mobile-login");
  await login(page);
  await authorize(page, request);
  await capture(page, "mobile-settings");
  await page.getByRole("link", { name: "发布规则", exact: true }).click();
  await manual(page);
  await capture(page, "mobile-editor");
  await page.getByRole("button", { name: "保存并发布" }).click();
  await expect(page.getByText("已广告", { exact: true })).toBeVisible();
  await capture(page, "mobile-rules");
  for (const path of ["/", "/settings", "/rules/new"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto("/rules");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveCount(1);
  await page.getByRole("button", { name: "删除 grafana" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  writeFileSync(
    `${assets}/responsive-audit.json`,
    JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        paths: ["/", "/settings", "/rules/new"],
        noHorizontalOverflow: true,
        keyboardFocus: true,
        deleteCancel: true,
      },
      null,
      2,
    ),
  );
});
