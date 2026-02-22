import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for live smoke tests.
 * Runs tests in e2e/live/ against the deployed djinn.gg site.
 *
 * Usage: npx playwright test --config=playwright.live.config.ts
 */
export default defineConfig({
  testDir: "./e2e/live",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 2,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  globalTimeout: 600_000,
  use: {
    baseURL: process.env.LIVE_URL ?? "https://djinn.gg",
    trace: "on-first-retry",
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "ui",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /onchain-smoke|signal-lifecycle/,
    },
    {
      name: "onchain",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /onchain-smoke\.spec\.ts/,
      dependencies: ["ui"],
    },
    {
      name: "lifecycle",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /signal-lifecycle\.spec\.ts/,
      dependencies: ["onchain"],
    },
  ],
});
