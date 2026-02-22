import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PW_BASE_URL ?? "https://djinn.gg";
const isRemote = !BASE_URL.includes("localhost");

export default defineConfig({
  testDir: "./e2e",
  // When targeting the live site, run the live tests; skip them for local builds
  testIgnore: isRemote ? [] : ["**/live/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 60_000,
  globalTimeout: 600_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Only start a local server when targeting localhost
  ...(isRemote
    ? {}
    : {
        webServer: {
          command: `NEXT_PUBLIC_E2E_TEST=true pnpm build && pnpm start -p ${new URL(BASE_URL).port || "3199"}`,
          url: BASE_URL,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: "pipe",
        },
      }),
});
