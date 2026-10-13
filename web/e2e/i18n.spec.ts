import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { buildID } from "./build-id";
const dir = process.env.ZTAIL_EVIDENCE_DIR || "test-results/i18n";
mkdirSync(dir, { recursive: true });
const base = "http://127.0.0.1:18090";
const save = (name: string, value: unknown) =>
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2));
const capture = (page: Page, name: string) =>
  page.screenshot({
    path: `${dir}/${name}.png`,
    fullPage: !/policy-|access-help-|delete-/.test(name),
  });
test.use({ locale: "en-US" });
async function login(page: Page, url = base) {
  await page.goto(url);
  await page
    .getByLabel("Admin password", { exact: true })
    .fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Zeabur services", exact: true }),
  ).toBeVisible();
}
async function switchTo(page: Page, locale: string) {
  await page.locator(".language-switcher").selectOption(locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}
async function fits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
test.beforeEach(async ({ request }) => {
  await request.get(base + "/fixture/reset");
  await request.get("/fixture/reset");
  expect((await (await request.get("/healthz")).json()).version).toBe(
    "e2e-" + buildID(),
  );
});

test("system defaults, script priority, stored preference and first render", async ({
  browser,
}) => {
  const matrix: [string, string, string?][] = [
    ["en-US", "en"],
    ["fr-FR", "en"],
    ["ja-JP", "en"],
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh-CN", "en", "en"],
    ["en-US", "zh-TW", "zh-TW"],
    ["zh-TW", "zh-CN", "zh-CN"],
    ["en-US", "en", "bad-value"],
  ];
  const records = [];
  for (const [language, expected, stored] of matrix) {
    const context = await browser.newContext({ locale: "en-US" });
    await context.addInitScript(
      ({ language, stored }) => {
        Object.defineProperty(navigator, "languages", {
          get: () => [language, "zh-CN"],
        });
        Object.defineProperty(navigator, "language", { get: () => language });
        if (stored) localStorage.setItem("ztail.locale", stored);
        const data: { text: string; lang: string; title: string }[] = [];
        (window as any).firstRender = data;
        new MutationObserver(() => {
          const root = document.querySelector("#root");
          if (root?.textContent && data.length < 2)
            data.push({
              text: root.textContent,
              lang: document.documentElement.lang,
              title: document.title,
            });
        }).observe(document, { childList: true, subtree: true });
      },
      { language, stored },
    );
    const page = await context.newPage();
    await page.goto(base);
    await expect(page.locator("#password")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", expected);
    await expect(page.locator(".language-switcher")).toHaveValue(expected);
    const record = await page.evaluate(() => ({
      locale: document.documentElement.lang,
      title: document.title,
      firstRender: (window as any).firstRender,
    }));
    expect(record.firstRender[0].lang).toBe(expected);
    expect(record.firstRender[0].text).toContain(
      expected === "en"
        ? "Loading session…"
        : "正在读取会话…".replace(
            expected === "zh-TW" ? "读取会话" : "___",
            expected === "zh-TW" ? "讀取工作階段" : "___",
          ),
    );
    if (["en-US", "zh-CN", "zh-TW"].includes(language) && !stored)
      await capture(page, "default-" + expected);
    records.push({ language, stored, expected, ...record });
    await context.close();
  }
  save("locale-defaults", records);
});

test("switch and reload preserve preference, session, password, unsaved form and blocked storage", async ({
  page,
  browser,
}) => {
  await page.goto(base);
  await page.locator("#password").fill("unsaved-password");
  await switchTo(page, "zh-TW");
  await expect(page.locator("#password")).toHaveValue("unsaved-password");
  await expect(
    page.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
  await switchTo(page, "en");
  await page.locator("#password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".catalog-summary")).toBeVisible();
  await page
    .getByRole("button", { name: "Add a backend manually", exact: true })
    .click();
  await page.locator("#service-name").fill("unsaved-locale");
  await switchTo(page, "zh-TW");
  await expect(page.locator("#service-name")).toHaveValue("unsaved-locale");
  await expect(
    page.getByRole("heading", { name: "發佈服務", exact: true }),
  ).toBeVisible();
  await capture(page, "preference-unsaved");
  expect(await page.evaluate(() => localStorage.getItem("ztail.locale"))).toBe(
    "zh-TW",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "發佈服務", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  await switchTo(page, "zh-CN");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "发布服务", exact: true }),
  ).toBeVisible();
  const context = await browser.newContext({ locale: "en-US" });
  await context.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "getItem", {
      value: () => {
        throw new DOMException("blocked");
      },
    });
    Object.defineProperty(Storage.prototype, "setItem", {
      value: () => {
        throw new DOMException("blocked");
      },
    });
  });
  const blocked = await context.newPage();
  await blocked.goto(base);
  await expect(blocked.locator("#password")).toBeVisible();
  await switchTo(blocked, "zh-TW");
  await expect(
    blocked.getByRole("button", { name: "登入", exact: true }),
  ).toBeVisible();
  await context.close();
  save("locale-preference", {
    saved: "zh-CN",
    passwordPreserved: true,
    unsavedFormPreserved: true,
    sessionPreservedOnReload: true,
    storageBlockedSwitchWorks: true,
  });
});

test("existing login and backend errors retranslate without submitting again", async ({
  page,
}) => {
  await page.goto(base);
  await page.locator("#password").fill("wrong");
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/session") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const payload = await (await response).json();
  expect(payload.errorInfo.key).toBe("Incorrect admin password");
  await expect(page.getByRole("alert")).toContainText(
    "Incorrect admin password",
  );
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts++;
  });
  await switchTo(page, "zh-TW");
  await expect(page.getByRole("alert")).toContainText("管理員密碼錯誤");
  await switchTo(page, "zh-CN");
  await expect(page.getByRole("alert")).toContainText("管理员密码错误");
  expect(posts).toBe(0);
  await capture(page, "translated-login-error");
  await switchTo(page, "en");
  await page.locator("#password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Add a backend manually", exact: true })
    .click();
  await page.locator("#service-name").fill("probe-fixture");
  await page.locator("#backend-host").fill("127.0.0.1");
  await page.locator("#protocol").selectOption("tcp");
  await page.locator("#port").fill("1");
  await page
    .getByRole("button", { name: "Test backend connection", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "TCP backend unreachable",
  );
  await switchTo(page, "zh-TW");
  await expect(page.getByRole("alert")).toContainText("TCP 後端不可達");
  await capture(page, "translated-probe-error");
  save("locale-errors-login-probe", { payload, retranslatedWithoutPost: true });
});

for (const locale of ["en", "zh-TW"] as const) {
  test(`all surfaces and policy errors in ${locale} at 390px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page);
    await page.request.get(base + "/fixture/authorize");
    await expect(page.locator(".catalog-server")).toContainText(
      "fixture-tailnet",
    );
    await switchTo(page, locale);
    const tr = (en: string, tw: string) => (locale === "en" ? en : tw);
    await expect(
      page.getByText(tr("Running", "執行中"), { exact: true }).first(),
    ).toBeVisible();
    await fits(page);
    await capture(page, "catalog-" + locale);
    await page
      .getByRole("button", {
        name: tr(
          "Publish Redis 6379 · Production",
          "發佈 Redis 6379 · Production",
        ),
        exact: true,
      })
      .click();
    await expect(
      page.getByLabel(tr("Published port", "發佈連接埠"), { exact: true }),
    ).toHaveValue("6379");
    await fits(page);
    await capture(page, "quick-" + locale);
    await page.locator(".quick-publish input[type=checkbox]").uncheck();
    await page
      .getByRole("button", {
        name: tr("Publish to tailnet", "發佈到 tailnet"),
        exact: true,
      })
      .click();
    await expect(
      page
        .getByRole("button", {
          name: tr("Configure access policy", "設定存取策略"),
          exact: true,
        })
        .first(),
    ).toBeVisible();
    const failing = await (await page.request.get(base + "/api/rules")).json();
    await page
      .getByRole("button", {
        name: tr("Configure access policy", "設定存取策略"),
        exact: true,
      })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: tr("Configure access policy for redis", "設定 redis 的存取策略"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#guide-service-port")).toHaveValue("6379");
    await fits(page);
    await capture(page, "policy-" + locale);
    await page
      .getByRole("button", {
        name: tr("Copy Policy fragment", "複製 策略片段"),
        exact: true,
      })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      "tcp:6379",
    );
    await page
      .getByRole("button", { name: tr("Close", "關閉"), exact: true })
      .click();
    await page
      .getByRole("link", { name: tr("Published", "已發佈"), exact: true })
      .click();
    await expect(page.locator(".rule-row")).toContainText("redis");
    await page.request.get(base + "/fixture/define?name=redis&port=6379");
    await page
      .getByRole("button", {
        name: tr("Retry redis", "重試 redis"),
        exact: true,
      })
      .click();
    await expect(page.locator(".rule-row .badge")).toContainText(
      tr("Published", "已發佈"),
    );
    await fits(page);
    await capture(page, "published-" + locale);
    await page
      .getByRole("button", {
        name: tr("Can't access a published service?", "無法存取已發佈的服務？"),
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await fits(page);
    await capture(page, "access-help-" + locale);
    await page
      .getByRole("button", { name: tr("Close", "關閉"), exact: true })
      .click();
    await page
      .getByRole("button", { name: tr("Edit", "編輯"), exact: true })
      .click();
    await expect(page.locator("#service-name")).toHaveValue("redis");
    await fits(page);
    await capture(page, "editor-" + locale);
    await page
      .getByRole("button", {
        name: tr("Back to published services", "返回已發佈服務"),
        exact: true,
      })
      .click();
    await page
      .getByRole("button", {
        name: tr("Delete service redis", "刪除服務 redis"),
        exact: true,
      })
      .click();
    await fits(page);
    await capture(page, "delete-" + locale);
    await page
      .getByRole("button", { name: tr("Cancel", "取消"), exact: true })
      .click();
    await page
      .getByRole("link", {
        name: tr("Connection settings", "連線設定"),
        exact: true,
      })
      .click();
    await expect(
      page.getByText(tr("Connected", "已連線"), { exact: true }),
    ).toBeVisible();
    await fits(page);
    await capture(page, "settings-" + locale);
    const cat = await (await page.request.get(base + "/api/catalog")).json();
    const expectedDate = new Date(cat.updatedAt).toLocaleString(locale);
    await expect(page.locator(".server-facts")).toContainText(expectedDate);
    const messages = await (await page.request.get(base + "/api/rules")).json();
    expect(failing[0].status.errorInfo.action).toBe("policy");
    expect(messages[0].status.state).toBe("advertised");
    save("surfaces-" + locale, {
      locale,
      policyError: failing[0].status,
      published: messages[0],
      clipboard: "tcp:6379",
      date: expectedDate,
      width: 390,
      allSurfacesFit: true,
    });
  });
}

test("README language links, technical parity and complete translation resources", async () => {
  const docs = ["../README.md", "../README.zh-CN.md", "../README.zh-TW.md"].map(
    (path) => readFileSync(path, "utf8"),
  );
  const commands = docs.map((doc) => doc.match(/```sh\n([\s\S]*?)```/)?.[1]);
  expect(commands[1]).toBe(commands[0]);
  expect(commands[2]).toBe(commands[0]);
  for (const doc of docs) {
    for (const key of [
      "ADMIN_PASSWORD",
      "ZEABUR_API_KEY",
      "ZEABUR_SERVER_ID",
      "TAILSCALE_API_KEY",
      "TAILSCALE_TAG",
      "CLUSTER_DOMAIN",
      "DATA_DIR",
      "PORT",
      "10001:10001",
      "/data",
      "tcp:6379",
      "tag:ztail-service",
      "tskey-auth-",
      "UDP",
      "WebSocket",
      "SSE",
    ])
      expect(doc).toContain(key);
  }
  for (const [index, doc] of docs.entries()) {
    for (const [other, filename] of [
      "README.md",
      "README.zh-CN.md",
      "README.zh-TW.md",
    ].entries())
      if (other !== index) expect(doc).toContain("](" + filename + ")");
  }
  const dicts = ["en", "zh-CN", "zh-TW"].map((lang) =>
    JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8")),
  );
  for (const dict of dicts.slice(1)) {
    expect(Object.keys(dict).sort()).toEqual(Object.keys(dicts[0]).sort());
    for (const key of Object.keys(dicts[0]))
      expect((dict[key].match(/\{\d+\}/g) || []).sort()).toEqual(
        (key.match(/\{\d+\}/g) || []).sort(),
      );
  }
  save("readme-locales", {
    technicalParity: true,
    languageLinks: true,
    translationKeys: Object.keys(dicts[0]).length,
    placeholderParity: true,
  });
});

test("policy parameters, refresh failures and asynchronous node errors update with locale", async ({
  page,
}) => {
  await login(page);
  await page.request.get(base + "/fixture/authorize");
  await page.request.get(base + "/fixture/define?name=redis&port=6379");
  await page
    .getByRole("button", {
      name: "Publish Redis 6379 · Production",
      exact: true,
    })
    .click();
  await page.locator(".quick-publish input[type=checkbox]").uncheck();
  await page.getByLabel("Published port", { exact: true }).fill("16379");
  await page
    .getByRole("button", { name: "Publish to tailnet", exact: true })
    .click();
  await expect(page.locator(".row-error").first()).toContainText("tcp:16379");
  await expect(
    page.getByRole("button", { name: "Configure access policy", exact: true }),
  ).toBeVisible();
  const failed = (await (await page.request.get(base + "/api/rules")).json())[0]
    .status;
  expect(failed.errorInfo.args).toEqual(["tcp:16379"]);
  expect(failed.errorInfo.action).toBe("policy");
  await switchTo(page, "zh-TW");
  await expect(page.locator(".row-error").first()).toContainText(
    "Service 必須僅定義 tcp:16379",
  );
  await expect(
    page.getByRole("button", { name: "設定存取策略", exact: true }),
  ).toBeVisible();
  await switchTo(page, "zh-CN");
  await expect(page.locator(".row-error").first()).toContainText(
    "Service 必须仅定义 tcp:16379",
  );
  await switchTo(page, "en");
  await page.request.get(base + "/fixture/failure?kind=catalog");
  await page
    .getByRole("button", { name: "Refresh service catalog", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Zeabur API returned HTTP 401",
  );
  await switchTo(page, "zh-TW");
  await expect(page.getByRole("alert")).toContainText(
    "Zeabur API 返回 HTTP 401",
  );
  await capture(page, "translated-policy-catalog-error");
  await page.request.get(base + "/fixture/failure?kind=catalog&enabled=false");
  await switchTo(page, "en");
  await page
    .getByRole("button", { name: "Refresh service catalog", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Connection settings", exact: true })
    .click();
  await page.request.get(base + "/fixture/auth-state?state=timeout");
  await expect(page.getByRole("alert")).toContainText("over 90 seconds");
  await switchTo(page, "zh-TW");
  await expect(page.getByRole("alert")).toContainText("等待超過 90 秒");
  await switchTo(page, "zh-CN");
  await expect(page.getByRole("alert")).toContainText("等待超过 90 秒");
  await capture(page, "translated-node-error");
  save("locale-errors-policy-node", {
    failed,
    policyParamsPreserved: true,
    catalogErrorRetranslated: true,
    nodeErrorRetranslated: true,
  });
});

test("mobile sign-in selector preserves input and supports keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await expect(page.locator("#password")).toBeVisible();
  await fits(page);
  await capture(page, "login-mobile-en");
  await page.locator("#password").fill("unsaved-mobile");
  const select = page.locator(".language-switcher");
  await select.focus();
  await expect(select).toBeFocused();
  await select.press("Tab");
  await expect(page.locator("#password")).toBeFocused();
  await page.locator("#password").press("Shift+Tab");
  await expect(select).toBeFocused();
  await switchTo(page, "zh-CN");
  await switchTo(page, "zh-TW");
  await expect(
    page.getByRole("heading", { name: "登入服務發佈面板", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#password")).toHaveValue("unsaved-mobile");
  await fits(page);
  await capture(page, "login-mobile-zh-TW");
  expect(await page.evaluate(() => localStorage.getItem("ztail.locale"))).toBe(
    "zh-TW",
  );
  save("locale-keyboard", {
    width: 390,
    languageChoices: ["en", "zh-CN", "zh-TW"],
    keyboardFocusAndTab: true,
    passwordPreserved: true,
    stored: "zh-TW",
    noOverflow: true,
  });
});
