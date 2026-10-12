import { test, expect, Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function login(page: Page) {
  await page.goto("/rules");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "发布规则", exact: true }),
  ).toBeVisible();
  await page.request.get("/fixture/authorize");
}
async function failingRule(page: Page) {
  await login(page);
  await page.getByRole("button", { name: "新增规则", exact: true }).click();
  await page.getByLabel("Service 名称", { exact: true }).fill("rsshub");
  await page.getByRole("button", { name: "手填地址", exact: true }).click();
  await page.getByLabel("后端主机名或 IP").fill("127.0.0.1");
  await page.getByLabel("后端端口", { exact: true }).fill("18082");
  await page.getByRole("button", { name: "保存并发布", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "配置访问策略", exact: true }),
  ).toBeVisible();
}
async function audit(page: Page) {
  return (await page.request.get("/fixture/audit")).json();
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
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
    `${assets}/policy-provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + hash,
        fixtures:
          "Zeabur/Tailnet control plane only; actual UI/HTTP/SQLite/manager",
      },
      null,
      2,
    ),
  );
});
test("rule error opens service-specific guide, copies field values and policy without changing configuration", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await failingRule(page);
  const before = await audit(page);
  await page.getByRole("button", { name: "配置访问策略", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "配置 rsshub 的访问策略",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Service name", { exact: true })).toHaveValue(
    "rsshub",
  );
  await expect(dialog.getByLabel("Ports", { exact: true })).toHaveValue("443");
  await expect(dialog.getByLabel("Service tags", { exact: true })).toHaveValue(
    "tag:ztail-service",
  );
  await expect(dialog).toContainText("后端端口 18082");
  await expect(dialog).toContainText("https://rsshub.fixture.ts.net");
  await expect(dialog.locator("pre")).toContainText("tag:custom-host");
  await expect(
    dialog.getByRole("link", { name: "打开 Services", exact: true }),
  ).toHaveAttribute("href", "https://console.tailscale.com/admin/services");
  await expect(
    dialog.getByRole("link", { name: "打开 Access controls", exact: true }),
  ).toHaveAttribute("href", "https://console.tailscale.com/admin/acls");
  const copied: Record<string, string> = {};
  for (const [label, value] of [
    ["Service name", "rsshub"],
    ["Ports", "443"],
    ["Service tags", "tag:ztail-service"],
  ]) {
    await dialog
      .getByRole("button", { name: "复制 " + label, exact: true })
      .click();
    copied[label] = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied[label]).toBe(value);
  }
  await dialog
    .getByRole("button", { name: "复制 策略片段", exact: true })
    .click();
  const policy = JSON.parse(
    await page.evaluate(() => navigator.clipboard.readText()),
  );
  const settings = await (await page.request.get("/api/settings")).json();
  expect(policy).toEqual(settings.policy);
  expect(policy.grants[0].src).toEqual(["autogroup:member", "tag:custom-host"]);
  await capture(page, "policy-guide-desktop");
  const after = await audit(page);
  expect(after.rules).toEqual(before.rules);
  expect(after.ads).toEqual(before.ads);
  expect(after.registryCalls).toEqual(before.registryCalls);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "配置访问策略", exact: true }),
  ).toBeFocused();
  writeFileSync(
    `${assets}/policy-copy-audit.json`,
    JSON.stringify({ before, after, copied, policy }, null, 2),
  );
});
test("guide traps keyboard focus, closes with Escape and explicitly retries the saved rule", async ({
  page,
}) => {
  await failingRule(page);
  const open = page.getByRole("button", { name: "配置访问策略", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "关闭配置指南", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "重试发布", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭配置指南", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await open.click();
  await dialog
    .getByRole("button", { name: "关闭配置指南", exact: true })
    .click();
  await expect(open).toBeFocused();
  await open.click();
  const state = await audit(page);
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/rules/" + state.rules[0].id + "/retry") &&
      r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "重试发布", exact: true }).click();
  expect((await response).status()).toBe(202);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "配置访问策略", exact: true }),
  ).toBeVisible();
  writeFileSync(
    `${assets}/policy-keyboard-audit.json`,
    JSON.stringify(
      {
        focusTrap: true,
        escapeRestoresFocus: true,
        closeRestoresFocus: true,
        bodyScrollRestored: true,
        retryHTTP: 202,
        rule: state.rules[0],
      },
      null,
      2,
    ),
  );
});
test("catalogue failures use the same guide and the modal is usable at 390px", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByRole("link", { name: "Zeabur 服务", exact: true }).click();
  await page
    .getByRole("button", {
      name: "发布 Grafana 3000 · Production",
      exact: true,
    })
    .click();
  await page.getByLabel("访问名称", { exact: true }).fill("catalog-rsshub");
  await page
    .getByRole("button", { name: "发布到 tailnet", exact: true })
    .click();
  const open = page.getByRole("button", { name: "配置访问策略", exact: true });
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByRole("dialog", {
    name: "配置 catalog-rsshub 的访问策略",
    exact: true,
  });
  await expect(dialog.getByLabel("Service name", { exact: true })).toHaveValue(
    "catalog-rsshub",
  );
  await expect(dialog.getByLabel("Ports", { exact: true })).toHaveValue("443");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await capture(page, "policy-guide-mobile-fields");
  await dialog
    .getByRole("button", { name: "复制 策略片段", exact: true })
    .click();
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
      .autoApprovers.services["tag:ztail-service"],
  ).toEqual(["tag:custom-host"]);
  await capture(page, "policy-guide-mobile-policy");
  await dialog
    .getByRole("heading", { name: "3. 重试发布并检查审批" })
    .scrollIntoViewIfNeeded();
  await capture(page, "policy-guide-mobile-finish");
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  writeFileSync(
    `${assets}/policy-mobile-audit.json`,
    JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        noHorizontalOverflow: true,
        policyCopied: true,
        receiver: await audit(page),
      },
      null,
      2,
    ),
  );
});
