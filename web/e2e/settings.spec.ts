import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, expect, Page } from "@playwright/test";

const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}
const policyLabel = "我已将策略片段合并到现有策略，并在 Tailscale 保存";
async function login(page: Page) {
  await page.goto("/settings");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /先配置 Tailscale 策略/ }),
  ).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.get("/fixture/reset");
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
    `${assets}/settings-provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + hash,
        fixtures:
          "real UI/HTTP/SQLite; fixture control plane; route-delay/error injections",
      },
      null,
      2,
    ),
  );
});

test("policy precedes login, merge warning is prominent and both login methods require acknowledgement", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(
    page.getByText("这是策略片段：合并到现有策略，勿覆盖整份策略。", {
      exact: true,
    }),
  ).toBeVisible();
  const policy = await page
    .getByRole("heading", { name: /先配置 Tailscale 策略/ })
    .boundingBox();
  const node = await page
    .getByRole("heading", { name: /授权 Tailscale 节点/ })
    .boundingBox();
  expect(policy!.y).toBeLessThan(node!.y);
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "打开 Tailscale 访问策略" }),
  ).toHaveAttribute("href", "https://login.tailscale.com/admin/acls");
  await capture(page, "settings-policy-mobile");
  await page.getByRole("button", { name: "复制待合并的策略片段" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const settings = await (await page.request.get("/api/settings")).json();
  expect(JSON.parse(copied)).toEqual(settings.policy);
  await page.getByText("查看需要合并的策略片段", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("tag:custom-host");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const audit = await (await page.request.get("/fixture/audit")).json();
  expect(audit.connects).toEqual([]);
  writeFileSync(
    `${assets}/settings-policy-audit.json`,
    JSON.stringify(
      {
        connects: audit.connects,
        policy: settings.policy,
        copiedPolicy: JSON.parse(copied),
      },
      null,
      2,
    ),
  );
  await capture(page, "settings-policy-expanded-mobile");
  await page.getByRole("checkbox", { name: policyLabel }).check();
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toBeEnabled();
  await page.getByText("查看需要合并的策略片段", { exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, "settings-policy-desktop");
});

test("interactive keeps loading after 202 until delayed URL is available, then navigates reserved tab", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("checkbox", { name: policyLabel }).check();
  let ready = false;
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, authUrl: ready ? status.authUrl : "" },
    });
  });
  const accepted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/api/tailscale/connect"),
  );
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  expect((await accepted).status()).toBe(202);
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeDisabled();
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeVisible();
  expect(popup.url()).toBe("about:blank");
  await capture(page, "settings-interactive-waiting");
  await capture(popup, "settings-pending-tab");
  const before = {
    httpStatus: 202,
    waitingURL: popup.url(),
    loading: await page
      .getByRole("button", { name: "正在获取授权链接…" })
      .getAttribute("aria-busy"),
  };
  ready = true;
  await popup.waitForURL("**/fixture/authorize");
  await capture(popup, "settings-authorized-tab");
  writeFileSync(
    `${assets}/settings-interactive-audit.json`,
    JSON.stringify(
      {
        before,
        after: { popupURL: popup.url() },
        audit: await (await page.request.get("/fixture/audit")).json(),
      },
      null,
      2,
    ),
  );
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await capture(page, "settings-interactive-connected");
  await popup.close();
});

test("blocked popup falls back to a fresh link and request failure restores the button", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await login(page);
  await page.getByRole("checkbox", { name: policyLabel }).check();
  await page.getByRole("button", { name: "交互式授权" }).click();
  await expect(
    page.getByText(/浏览器阻止了新标签页或等待页已关闭/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "打开 Tailscale 授权页面" }),
  ).toHaveAttribute("href", "http://127.0.0.1:18080/fixture/authorize");
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  await capture(page, "settings-popup-fallback");
  await page.route("**/api/tailscale/connect", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "无法启动 Tailscale 登录，请重试" },
    }),
  );
  await page.getByRole("button", { name: "交互式授权" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "无法启动 Tailscale 登录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "打开 Tailscale 授权页面" }),
  ).toHaveCount(0);
  await capture(page, "settings-login-error");
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
});

test("failed request and timed-out URL wait close pending tabs and allow retry", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("checkbox", { name: policyLabel }).check();
  await page.route("**/api/tailscale/connect", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "无法启动 Tailscale 登录，请重试" },
    }),
  );
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/tailscale/connect"),
  );
  const [failedTab] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  expect((await response).status()).toBe(400);
  await expect(
    page.getByRole("alert").filter({ hasText: "无法启动 Tailscale 登录" }),
  ).toBeVisible();
  await expect.poll(() => failedTab.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  await capture(page, "settings-request-error");
  await page.unroute("**/api/tailscale/connect");
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), authUrl: "" },
    });
  });
  await page.clock.install();
  const [waitingTab] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeVisible();
  await page.clock.fastForward(90_001);
  await expect(
    page.getByRole("alert").filter({ hasText: "等待授权链接超过 90 秒" }),
  ).toBeVisible();
  await expect.poll(() => waitingTab.isClosed()).toBe(true);
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  await capture(page, "settings-url-timeout");
  writeFileSync(
    `${assets}/settings-recovery-audit.json`,
    JSON.stringify(
      {
        requestStatus: 400,
        failedTabClosed: failedTab.isClosed(),
        timeoutMilliseconds: 90001,
        timedOutTabClosed: waitingTab.isClosed(),
        canRetry: true,
      },
      null,
      2,
    ),
  );
});

test("leaving settings while waiting cancels polling and closes the pending tab", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("checkbox", { name: policyLabel }).check();
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), authUrl: "" },
    });
  });
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Zeabur 服务", exact: true }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  writeFileSync(
    `${assets}/settings-cancellation-audit.json`,
    JSON.stringify(
      { pendingTabClosed: popup.isClosed(), pageURL: page.url() },
      null,
      2,
    ),
  );
});
