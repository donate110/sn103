import { chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * Warm-up script: Opens the site in a visible browser to pass the Vercel
 * Security Checkpoint, then saves session cookies for headless test runs.
 *
 * Usage: npx playwright test --config playwright.ux.config.ts e2e/ux/warmup.ts
 * Or:    npx tsx e2e/ux/warmup.ts
 *
 * After running this, headless test runs will use the saved cookies
 * to skip the checkpoint for up to 12 hours.
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";
const SESSION_PATH = path.join(__dirname, ".vercel-session.json");

async function main() {
  console.log("[warmup] Launching headed browser...");
  console.log("[warmup] Target:", BASE_URL);
  console.log(
    "[warmup] If a Vercel checkpoint appears, it should auto-resolve.",
  );
  console.log("[warmup] If it doesn't, just wait or interact with the page.\n");

  // Use headed mode if DISPLAY is available, otherwise headless
  const hasDisplay = !!process.env.DISPLAY;
  const browser = await chromium.launch({
    headless: !hasDisplay,
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Wait for either the checkpoint to resolve or the real page to load
  console.log("[warmup] Waiting for page to load...");

  const maxWait = 60_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const title = await page.title();
    if (!title.includes("Vercel Security Checkpoint")) {
      console.log(`[warmup] Page loaded: "${title}"`);
      break;
    }
    await page.waitForTimeout(1_000);
  }

  // Save session state
  const state = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
  console.log(`\n[warmup] Session saved to ${SESSION_PATH}`);
  console.log("[warmup] Headless tests will use these cookies for up to 12 hours.");

  await browser.close();
}

main().catch((err) => {
  console.error("[warmup] Error:", err.message);
  process.exit(1);
});
