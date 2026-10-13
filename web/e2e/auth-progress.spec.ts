import { buildID } from "./build-id";
import { test, expect, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
async function login(page: Page) {
  await page.goto("/settings");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toBeEnabled();
}
async function capture(page: Page, name: string) {
  await page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
}
test.beforeEach(async ({ request }) => {
  await request.get("/fixture/reset");
  const version = buildID();
  const health = await (await request.get("/healthz")).json();
  expect(health.version).toBe("e2e-" + version);
  writeFileSync(
    `${assets}/auth-progress-provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + version,
        fixtures:
          "real UI/HTTP; fixture control plane; delayed stale browser response",
      },
      null,
      2,
    ),
  );
});

test("Auth Key owns its spinner until connected, and a stale refresh cannot undo success", async ({
  page,
  request,
}) => {
  await login(page);
  let release!: () => void;
  let captured!: () => void;
  const staleReady = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const staleGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route("**/api/tailscale", async (route) => {
    const response = await route.fetch();
    if (first) {
      first = false;
      captured();
      await staleGate;
    }
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "刷新状态" }).click();
  await staleReady;
  await page.getByLabel("或使用 Auth Key").fill("tskey-auth-fixture-valid");
  const accepted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/tailscale/connect") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "使用 Auth Key 加入" }).click();
  expect((await accepted).status()).toBe(202);
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("button", { name: "交互式授权" }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("接入中", { exact: true })).toBeVisible();
  const form = page.locator("form").filter({ has: page.locator("#auth-key") });
  await expect(
    form.getByText("正在使用 Auth Key 接入，等待 Tailscale 确认…", {
      exact: true,
    }),
  ).toBeVisible();
  await request.get("/fixture/auth-state?state=joining");
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveAttribute("aria-busy", "true");
  await capture(page, "key-pending-owned");
  await request.get("/fixture/authorize");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  release();
  await page.unrouteAll({ behavior: "wait" });
  // Give the held background fetch time to parse and commit its stale status.
  await page.waitForTimeout(150);
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText("等待授权", { exact: true })).toHaveCount(0);
  const server = (await page
    .getByRole("heading", { name: "Zeabur 服务器", exact: true })
    .boundingBox())!;
  const node = (await page
    .getByRole("heading", { name: "Tailscale 节点", exact: true })
    .boundingBox())!;
  expect(Math.abs(server.y - node.y)).toBeLessThan(2);
  expect(server.x + server.width).toBeLessThan(node.x);
  await capture(page, "key-connected-stable");
  writeFileSync(
    `${assets}/key-progress-audit.json`,
    JSON.stringify(
      {
        acceptedStatus: 202,
        startingSpinner: "authkey",
        interactiveBusy: false,
        staleRefreshState: "NeedsLogin",
        finalState: "Running",
        connectedLayout: { server, node },
        audit: await (await request.get("/fixture/audit")).json(),
      },
      null,
      2,
    ),
  );
});

test("interactive URL transitions to waiting for authorization, and opens only once", async ({
  page,
  context,
  request,
}) => {
  await context.route("**/fixture/authorize", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><p>Control-plane authorization pending</p>",
    }),
  );
  await login(page);
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "交互式授权" }).click(),
  ]);
  await popup.waitForURL("**/fixture/authorize");
  await expect(
    page.getByRole("button", { name: "等待授权完成…" }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("link", { name: "打开 Tailscale 授权页面" }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(context.pages()).toHaveLength(2);
  await capture(page, "interactive-awaiting-confirmation");
  await request.get("/fixture/authorize");
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  const server = (await page
    .getByRole("heading", { name: "Zeabur 服务器", exact: true })
    .boundingBox())!;
  const node = (await page
    .getByRole("heading", { name: "Tailscale 节点", exact: true })
    .boundingBox())!;
  expect(Math.abs(server.y - node.y)).toBeLessThan(2);
  expect(server.x + server.width).toBeLessThan(node.x);
  writeFileSync(
    `${assets}/interactive-progress-audit.json`,
    JSON.stringify(
      {
        url: popup.url(),
        tabCount: context.pages().length,
        phaseBefore: "waiting-authorization",
        finalState: "Running",
        connectedLayout: { server, node },
      },
      null,
      2,
    ),
  );
  await popup.close();
});

test("Auth Key timeout stops its spinner with a clear result and retry", async ({
  page,
}) => {
  await login(page);
  await page.clock.install();
  await page.getByLabel("或使用 Auth Key").fill("tskey-auth-fixture-pending");
  await page.getByRole("button", { name: "使用 Auth Key 加入" }).click();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveAttribute("aria-busy", "true");
  await page.clock.fastForward(90001);
  await expect(
    page.getByRole("alert").filter({ hasText: "Auth Key 接入等待超过 90 秒" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "使用 Auth Key 加入" }),
  ).toBeEnabled();
  await capture(page, "key-foreground-timeout");
});

test("only expected unaccepted-routes notice is hidden; connectivity warning remains", async ({
  page,
  request,
}) => {
  await login(page);
  await request.get("/fixture/authorize");
  await request.get("/fixture/auth-state?state=routes");
  await page.reload();
  await expect(page.getByText("已连接", { exact: true })).toBeVisible();
  await expect(page.getByText(/Tailscale 健康提示/)).toHaveCount(0);
  const rawResponse = await page.request.get("/api/tailscale");
  expect(rawResponse.status()).toBe(200);
  const raw = await rawResponse.json();
  expect(raw.health).toEqual([
    "Some peers are advertising routes but --accept-routes is false",
  ]);
  await capture(page, "routes-notice-hidden");
  await request.get("/fixture/auth-state?state=mixed-health");
  await page.getByRole("button", { name: "刷新状态" }).click();
  await expect(
    page.getByText(/Tailscale 健康提示：Unable to connect/),
  ).toBeVisible();
  await expect(page.getByText(/Some peers are advertising routes/)).toHaveCount(
    0,
  );
  await capture(page, "connectivity-warning-retained");
  writeFileSync(
    `${assets}/health-warning-audit.json`,
    JSON.stringify(
      {
        routeOnly: raw.health,
        mixed: (await (await page.request.get("/api/tailscale")).json()).health,
        retainedVisible:
          "Unable to connect to the Tailscale coordination server",
      },
      null,
      2,
    ),
  );
});
