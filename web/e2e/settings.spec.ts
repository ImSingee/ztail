import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test, expect, Page } from "@playwright/test";

const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}
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

test("server context comes first, policy opens by default without acknowledgement input", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  const y = async (name: RegExp) =>
    (await page.getByRole("heading", { name }).boundingBox())!.y;
  expect(await y(/^Zeabur 服务器$/)).toBeLessThan(
    await y(/先配置 Tailscale 策略/),
  );
  expect(await y(/先配置 Tailscale 策略/)).toBeLessThan(
    await y(/授权 Tailscale 节点/),
  );
  await expect(page.locator(".policy-preview")).toHaveAttribute("open", "");
  await expect(page.locator("pre")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toBeEnabled();
  await expect(
    page.getByText("这是策略片段：合并到现有策略，勿覆盖整份策略。", {
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, "settings-policy-desktop");
  await page.getByRole("button", { name: "复制待合并的策略片段" }).click();
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  const settings = await (await page.request.get("/api/settings")).json();
  expect(copied).toEqual(settings.policy);
  expect(JSON.stringify(copied)).toContain("tag:custom-host");
  const audit = await (await page.request.get("/fixture/audit")).json();
  expect(audit.connects).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "settings-policy-mobile");
  writeFileSync(
    `${assets}/settings-policy-audit.json`,
    JSON.stringify(
      {
        order: "server,policy,node",
        policyDefaultOpen: true,
        acknowledgementInputs: 0,
        connects: audit.connects,
        policy: settings.policy,
        copiedPolicy: copied,
      },
      null,
      2,
    ),
  );
});

test("interactive keeps loading after 202 with no intermediate tab, and opens final URL when ready", async ({
  page,
  context,
}) => {
  await login(page);
  let ready = false;
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, authUrl: ready ? status.authUrl : "" },
    });
  });
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/api/tailscale/connect"),
  );
  await page.getByRole("button", { name: "交互式授权" }).click();
  expect((await response).status()).toBe(202);
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toHaveAttribute("aria-busy", "true");
  await page.waitForTimeout(1500);
  expect(context.pages()).toHaveLength(1);
  await capture(page, "settings-interactive-waiting");
  const before = {
    httpStatus: 202,
    tabCount: context.pages().length,
    loading: await page
      .getByRole("button", { name: "正在获取授权链接…" })
      .getAttribute("aria-busy"),
  };
  const popupPromise = page.waitForEvent("popup");
  ready = true;
  const popup = await popupPromise;
  await popup.waitForURL("**/fixture/authorize");
  await capture(popup, "settings-authorized-tab");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await capture(page, "settings-interactive-connected");
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
  await popup.close();
});

test("blocked popup provides fresh manual link and failed retry hides old link", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await login(page);
  await page.getByRole("button", { name: "交互式授权" }).click();
  await expect(
    page.getByText(/浏览器阻止了新标签页，请点击下方链接打开/),
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
});

test("failure and timeout allow retry without opening any tab", async ({
  page,
  context,
}) => {
  await login(page);
  await page.route("**/api/tailscale/connect", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "无法启动 Tailscale 登录，请重试" },
    }),
  );
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/tailscale/connect"),
  );
  await page.getByRole("button", { name: "交互式授权" }).click();
  expect((await response).status()).toBe(400);
  await expect(
    page.getByRole("alert").filter({ hasText: "无法启动 Tailscale 登录" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
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
  await page.getByRole("button", { name: "交互式授权" }).click();
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeVisible();
  await page.clock.fastForward(90001);
  await expect(
    page.getByRole("alert").filter({ hasText: "等待授权链接超过 90 秒" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "交互式授权" })).toBeEnabled();
  expect(context.pages()).toHaveLength(1);
  await capture(page, "settings-url-timeout");
  writeFileSync(
    `${assets}/settings-recovery-audit.json`,
    JSON.stringify(
      {
        requestStatus: 400,
        timeoutMilliseconds: 90001,
        tabCount: context.pages().length,
        canRetry: true,
      },
      null,
      2,
    ),
  );
});

test("leaving settings cancels waiting without opening a late authorization tab", async ({
  page,
  context,
}) => {
  await login(page);
  let ready = false;
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({
      response,
      json: { ...status, authUrl: ready ? status.authUrl : "" },
    });
  });
  await page.getByRole("button", { name: "交互式授权" }).click();
  await expect(
    page.getByRole("button", { name: "正在获取授权链接…" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Zeabur 服务", exact: true }).click();
  ready = true;
  await page.waitForTimeout(1500);
  expect(context.pages()).toHaveLength(1);
  writeFileSync(
    `${assets}/settings-cancellation-audit.json`,
    JSON.stringify(
      {
        tabCount: context.pages().length,
        pageURL: page.url(),
        lateURLAvailable: true,
      },
      null,
      2,
    ),
  );
});

test("authorized cold-load prioritizes node status and retains quiet policy reference on desktop and mobile", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.request.get("/fixture/authorize");
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    await loaded;
    await route.fulfill({ response });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("正在读取节点连接状态…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /先配置 Tailscale 策略/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "交互式授权" })).toHaveCount(0);
  await capture(page, "settings-connected-loading");
  release();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("button", { name: "交互式授权" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /先配置 Tailscale 策略/ }),
  ).toHaveCount(0);
  await expect(page.locator(".connected-policy")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator("pre")).toBeHidden();
  const serverY = (await page
    .getByRole("heading", { name: "Zeabur 服务器", exact: true })
    .boundingBox())!.y;
  const nodeY = (await page
    .getByRole("heading", { name: "Tailscale 节点", exact: true })
    .boundingBox())!.y;
  const policyY = (await page
    .getByText("访问策略与合并片段", { exact: true })
    .boundingBox())!.y;
  expect(serverY).toBeLessThan(nodeY);
  expect(nodeY).toBeLessThan(policyY);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, "settings-connected-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "settings-connected-mobile");
  await page.getByText("访问策略与合并片段", { exact: true }).click();
  await expect(page.locator("pre")).toBeVisible();
  await page.getByRole("button", { name: "复制待合并的策略片段" }).click();
  const copied = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  const settings = await (await page.request.get("/api/settings")).json();
  expect(copied).toEqual(settings.policy);
  await capture(page, "settings-connected-policy-expanded");
  await page.reload();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.locator("pre")).toBeHidden();
  writeFileSync(
    `${assets}/settings-connected-audit.json`,
    JSON.stringify(
      {
        coldLoadState: "Running",
        loadingOnboardingHidden: true,
        order: "server,node,collapsedPolicy",
        policy: settings.policy,
        copiedPolicy: copied,
        afterReloadCollapsed: true,
      },
      null,
      2,
    ),
  );
});
