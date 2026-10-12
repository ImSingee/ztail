import { test, expect, type Page } from "@playwright/test";
import { connect } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const assets = process.env.ZTAIL_EVIDENCE_DIR || "test-results/evidence";
mkdirSync(assets, { recursive: true });
const apiBase = "http://127.0.0.1:18090";
const capture = (page: Page, name: string) =>
  page.screenshot({ path: `${assets}/${name}.png`, fullPage: true });
const audit = async (page: Page, base = "") =>
  (await page.request.get(base + "/fixture/audit")).json();

async function login(page: Page, base = "") {
  await page.goto(base + "/");
  await page.getByLabel("管理员密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Zeabur 服务", exact: true }),
  ).toBeVisible();
  await page.request.get(base + "/fixture/authorize");
}

function echo(address: string, payload: Buffer): Promise<string> {
  const { hostname, port } = new URL(address);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) });
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("TCP echo timeout")),
    );
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const result = Buffer.concat(chunks);
      if (!result.equals(payload))
        reject(new Error("TCP binary payload differs"));
      else resolve(result.toString("hex"));
    });
  });
}

test.beforeEach(async ({ request }) => {
  await request.get("/fixture/reset");
  await request.get(apiBase + "/fixture/reset");
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
    `${assets}/tcp-provenance.json`,
    JSON.stringify(
      {
        health,
        expectedVersion: "e2e-" + hash,
        fixture:
          "Catalog/Tailnet/Registry control plane; production UI, App, SQLite, manager and TCP runtime; sockets real",
      },
      null,
      2,
    ),
  );
});

test("TCP catalogue publishing, custom port persistence and raw socket forwarding", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, apiBase);
  const redis = page.getByRole("article", {
    name: "Redis · Production",
    exact: true,
  });
  await expect(redis.getByRole("button", { name: /发布/ })).toHaveCount(1);
  await page
    .getByRole("button", { name: "发布 Redis 6379 · Production", exact: true })
    .click();
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "6379",
  );
  await expect(
    page.getByText("redis.fixture.ts.net:6379", { exact: true }),
  ).toBeVisible();
  await capture(page, "tcp-inline-desktop");
  await page.getByLabel("发布端口", { exact: true }).fill("16379");
  await expect(
    page.getByText("redis.fixture.ts.net:16379", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "发布到 tailnet", exact: true })
    .click();
  await expect(redis.getByText("已发布", { exact: true })).toBeVisible();
  const published = await audit(page, apiBase);
  expect(published.rules[0]).toMatchObject({
    name: "redis",
    protocol: "tcp",
    port: 6379,
    publishPort: 16379,
    environmentId: "env-first",
    serviceId: "service-db",
    enabled: true,
  });
  expect(published.definitions["svc:redis"].ports).toEqual(["tcp:16379"]);
  await redis.getByRole("button", { name: "管理发布", exact: true }).click();
  await expect(page.getByLabel("后端协议", { exact: true })).toHaveValue("tcp");
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "16379",
  );
  await page.reload();
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "16379",
  );
  await page.getByRole("button", { name: "手填地址", exact: true }).click();
  const backend = new URL("tcp://" + published.tcpBackendAddress);
  await page.getByLabel("后端主机名或 IP").fill(backend.hostname);
  await page.getByLabel("后端端口", { exact: true }).fill(backend.port);
  await page.getByRole("button", { name: "测试后端连接", exact: true }).click();
  await expect(
    page.getByText("TCP 端口可连接（未验证应用协议）", { exact: true }),
  ).toBeVisible();
  await capture(page, "tcp-editor-desktop");
  await page.getByRole("button", { name: "保存并发布", exact: true }).click();
  const row = page
    .locator(".rule-row")
    .filter({ has: page.getByRole("link", { name: "redis", exact: true }) });
  await expect(row.getByText("TCP 端口可连接", { exact: true })).toBeVisible();
  await expect(
    row.getByText("redis.fixture.ts.net:16379", { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "访问 redis", exact: true }),
  ).toHaveCount(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await row.getByRole("button", { name: "复制地址", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "redis.fixture.ts.net:16379",
  );
  const working = await audit(page, apiBase);
  const hex = await echo(
    working.addresses.redis,
    Buffer.from([0, 255, 0, 17, 128, 13, 10]),
  );
  await capture(page, "tcp-published-desktop");
  writeFileSync(
    `${assets}/tcp-publish-audit.json`,
    JSON.stringify(
      {
        published,
        working,
        rawSocket: {
          inputHex: "00ff0011800d0a",
          outputHex: hex,
          address: working.addresses.redis,
        },
        clipboard: "redis.fixture.ts.net:16379",
        browserLinkCount: 0,
      },
      null,
      2,
    ),
  );
});

test("TCP no-API policy uses service port, keeps panel443 and mobile forms fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page
    .getByRole("button", { name: "发布 Redis 6379 · Production", exact: true })
    .click();
  await page.getByLabel("发布端口", { exact: true }).fill("6380");
  await expect(
    page.getByText("redis.fixture.ts.net:6380", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "tcp-inline-mobile");
  await page.getByRole("button", { name: "完整配置", exact: true }).click();
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "6380",
  );
  await page.getByLabel("发布端口", { exact: true }).fill("0");
  await page.getByRole("button", { name: "保存并发布", exact: true }).click();
  expect((await audit(page)).rules).toHaveLength(0);
  await page.getByLabel("发布端口", { exact: true }).fill("6380");
  await capture(page, "tcp-editor-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "保存并发布", exact: true }).click();
  await page.getByRole("button", { name: "配置访问策略", exact: true }).click();
  await expect(page.getByLabel("Ports", { exact: true })).toHaveValue("6380");
  const policy = JSON.parse(
    (await page
      .getByLabel("Tailscale 策略片段", { exact: true })
      .textContent()) || "{}",
  );
  expect(policy.grants[0].ip).toEqual(["tcp:6380"]);
  expect(policy.grants[1].ip).toEqual(["tcp:443"]);
  await expect(
    page
      .getByRole("dialog")
      .getByText("redis.fixture.ts.net:6380", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/TCP 无需 HTTPS 证书/)).toBeVisible();
  await capture(page, "tcp-policy-mobile");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制 Ports", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "6380",
  );
  await page.getByRole("button", { name: "关闭配置指南", exact: true }).click();
  await page.request.get("/fixture/define?name=redis&port=6380");
  await expect(page.getByText("已发布", { exact: true }).last()).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const state = await audit(page);
  const backend = new URL("tcp://" + state.tcpBackendAddress);
  await page.getByRole("button", { name: "手填地址", exact: true }).click();
  await page.getByLabel("后端主机名或 IP").fill(backend.hostname);
  await page.getByLabel("后端端口", { exact: true }).fill("1");
  await page.getByRole("button", { name: "测试后端连接", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "TCP 后端不可达，请检查地址、端口和集群网络",
  );
  await capture(page, "tcp-probe-error-mobile");
  writeFileSync(
    `${assets}/tcp-policy-audit.json`,
    JSON.stringify(
      {
        policy,
        persisted: state.rules[0],
        invalidPortBlocked: true,
        copiedPort: "6380",
        noHorizontalOverflow: true,
        probeError: "TCP 后端不可达，请检查地址、端口和集群网络",
      },
      null,
      2,
    ),
  );
});

test("new manual TCP defaults follow backend port until explicitly customized", async ({
  page,
}) => {
  await login(page, apiBase);
  await page.getByRole("button", { name: "手动添加后端", exact: true }).click();
  await page.getByLabel("Service 名称", { exact: true }).fill("manual-db");
  await page.getByLabel("后端主机名或 IP").fill("127.0.0.1");
  await page.getByLabel("后端协议", { exact: true }).selectOption("tcp");
  await page.getByLabel("后端端口", { exact: true }).fill("5432");
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "5432",
  );
  await page.getByLabel("发布端口", { exact: true }).fill("15432");
  const before = await audit(page, apiBase);
  const backend = new URL("tcp://" + before.tcpBackendAddress);
  await page.getByLabel("后端端口", { exact: true }).fill(backend.port);
  await expect(page.getByLabel("发布端口", { exact: true })).toHaveValue(
    "15432",
  );
  await page.getByLabel("名称尚未定义时，通过 API 创建 Service").check();
  await page.getByRole("button", { name: "保存并发布", exact: true }).click();
  await expect(page.getByText("TCP 端口可连接", { exact: true })).toBeVisible();
  const after = await audit(page, apiBase);
  expect(after.rules[0]).toMatchObject({
    name: "manual-db",
    protocol: "tcp",
    publishPort: 15432,
    port: Number(backend.port),
  });
  const output = await echo(
    after.addresses["manual-db"],
    Buffer.from([0, 7, 255, 32]),
  );
  writeFileSync(
    `${assets}/tcp-manual-default-audit.json`,
    JSON.stringify(
      {
        defaultAfterBackendChange: 5432,
        customPublicPort: 15432,
        after,
        socketInputHex: "0007ff20",
        socketOutputHex: output,
      },
      null,
      2,
    ),
  );
});
