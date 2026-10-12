import { test, expect, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function connect(page: Page) {
  await page.goto("/settings");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("checkbox", {
      name: "我已将策略片段合并到现有策略，并在 Tailscale 保存",
    })
    .check();
  await page.getByLabel("或使用 Auth Key").fill("tskey-auth-fixture-valid");
  const accepted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/tailscale/connect") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "使用 Auth Key 加入" }).click();
  expect((await accepted).status()).toBe(202);
  await expect(
    page.getByText("正在使用 Auth Key 接入，等待 Tailscale 确认…"),
  ).toBeVisible();
  await expect(page.getByLabel("或使用 Auth Key")).toHaveValue("");
  await expect(page.getByText("已连接", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "打开 Tailscale 授权页面" }),
  ).toHaveCount(0);
}
test.beforeEach(async ({ request }) => {
  await request.get("/fixture/reset");
});
test("Auth Key acceptance shows pending across reload, async error and successful retry", async ({
  page,
  request,
}) => {
  await connect(page);
  await page.reload();
  await expect(
    page.getByText("正在使用 Auth Key 接入，等待 Tailscale 确认…"),
  ).toBeVisible();
  await page.screenshot({ path: `${assets}/auth-pending.png`, fullPage: true });
  await request.get("/fixture/auth-state?state=error");
  await expect(
    page.getByRole("alert").filter({ hasText: "invalid authkey" }),
  ).toBeVisible();
  await expect(
    page.getByText("正在使用 Auth Key 接入，等待 Tailscale 确认…"),
  ).toHaveCount(0);
  await page.screenshot({ path: `${assets}/auth-invalid.png`, fullPage: true });
  await page
    .getByRole("checkbox", {
      name: "我已将策略片段合并到现有策略，并在 Tailscale 保存",
    })
    .check();
  await page.getByLabel("或使用 Auth Key").fill("tskey-auth-fixture-retry");
  await page.getByRole("button", { name: "使用 Auth Key 加入" }).click();
  await expect(
    page.getByText("正在使用 Auth Key 接入，等待 Tailscale 确认…"),
  ).toBeVisible();
  await request.get("/fixture/authorize");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `${assets}/auth-connected.png`,
    fullPage: true,
  });
  const audit = await (await request.get("/fixture/audit")).json();
  expect(audit.connects).toEqual([
    { method: "authkey", authKeyPresent: true },
    { method: "authkey", authKeyPresent: true },
  ]);
  writeFileSync(`${assets}/auth-ui-audit.json`, JSON.stringify(audit, null, 2));
});
test("Auth Key wait surfaces health, timeout and administrator approval at 390px", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  await request.get("/fixture/auth-state?state=health");
  await expect(
    page.getByText(/Tailscale 健康提示：Unable to connect/),
  ).toBeVisible();
  await request.get("/fixture/auth-state?state=timeout");
  await expect(
    page.getByRole("alert").filter({ hasText: "等待超过 90 秒" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${assets}/auth-timeout-mobile.png`,
    fullPage: true,
  });
  await request.get("/fixture/auth-state?state=approval");
  await expect(page.getByText("等待节点审批", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "打开节点管理" }),
  ).toHaveAttribute("href", "https://login.tailscale.com/admin/machines");
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${assets}/auth-approval-mobile.png`,
    fullPage: true,
  });
});
