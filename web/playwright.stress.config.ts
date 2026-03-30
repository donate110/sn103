import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the long-running signal stress test.
 *
 * Usage:
 *   npx playwright test --config=playwright.stress.config.ts
 *   npx playwright test --config=playwright.stress.config.ts --grep "genius"
 */
export default defineConfig({
  testDir: "./e2e/live",
  testMatch: /signal-stress-loop\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  // 24-hour global timeout; individual test timeouts are set per-test
  timeout: 86_400_000,
  globalTimeout: 86_400_000,
  use: {
    baseURL: process.env.LIVE_URL ?? "https://www.djinn.gg",
    trace: "off",
    screenshot: "off",
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "stress",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        launchOptions: {
          args: ["--disable-blink-features=AutomationControlled"],
        },
      },
    },
  ],
});
