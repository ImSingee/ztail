import { buildID } from "./e2e/build-id";
import { defineConfig } from "@playwright/test";
const version = buildID();
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:18080",
    locale: "zh-CN",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      'cd .. && go test ./internal/ztail -run "^TestBrowserServer$" -count=1 -timeout=10m',
    url: "http://127.0.0.1:18080/healthz",
    reuseExistingServer: false,
    timeout: 120000,
    env: { ZTAIL_E2E: "1", ZTAIL_BUILD_ID: version },
  },
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
});
