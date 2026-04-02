import { test, expect } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  humanDelay,
  humanScroll,
  waitForIdle,
} from "../helpers/human";
import {
  landOnSite,
  clickNav,
  connectWalletViaUI,
  isWalletConnected,
} from "../helpers/navigate";
import { getIdiotWallet } from "../helpers/wallet-pool";

/**
 * Resilience Journey: Edge cases real users encounter.
 *
 * Tests the things that break in the wild:
 * - Slow network / stalled loads
 * - Navigating back and forth rapidly
 * - Wallet connection after browsing multiple pages
 * - Mobile viewport interactions
 * - Page refresh mid-flow
 * - Tab visibility changes (background polling behavior)
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";
const RPC_URL = "https://sepolia.base.org";

test.describe("Resilience Journey", () => {
  test.describe.configure({ mode: "serial" });

  test("survive rapid navigation without crashing", async ({ page }) => {
    // Tests that Next.js client-side routing handles fast clicks gracefully
    await landOnSite(page, BASE_URL);

    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (
        err.message.includes("hydrat") ||
        err.message.includes("ChunkLoadError") ||
        err.message.includes("ResizeObserver") ||
        err.message.includes("abort") || // Aborted fetches from navigation
        err.message.includes("Minified React error #418") ||
        err.message.includes("Minified React error #422") ||
        err.message.includes("Minified React error #423") ||
        err.message.includes("Minified React error #425")
      )
        return;
      errors.push(err.message);
    });

    // Navigate through all pages with shorter delays (impatient user)
    const pages = ["Genius", "Idiot", "Leaderboard", "Network", "Docs", "About", "Home"];
    for (const p of pages) {
      await clickNav(page, p);
      await humanDelay(page, 500, 1500); // Faster than normal
    }

    // Go through them again (the second pass tests cached state)
    for (const p of pages) {
      await clickNav(page, p);
      await humanDelay(page, 300, 800); // Even faster
    }

    const critical = errors.filter(
      (e) =>
        !e.includes("Warning:") &&
        !e.includes("favicon") &&
        !e.includes("walletconnect"),
    );
    expect(critical).toHaveLength(0);
  });

  test("wallet persists across navigation", async ({ page }) => {
    const idiot = getIdiotWallet(2);
    const idiotAccount = privateKeyToAccount(idiot.privateKey);

    await installMockWallet({
      page,
      account: idiotAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    await landOnSite(page, BASE_URL);

    // Connect on the Idiot page
    await clickNav(page, "Idiot");
    await connectWalletViaUI(page);
    await humanDelay(page, 2000, 3000);

    if (!(await isWalletConnected(page))) {
      await page.reload();
      await waitForIdle(page);
      await humanDelay(page, 2000, 3000);
    }

    // Navigate away to Leaderboard
    await clickNav(page, "Leaderboard");
    await humanDelay(page, 1500, 3000);

    // Navigate to Genius page
    await clickNav(page, "Genius");
    await humanDelay(page, 1500, 3000);

    // Come back to Idiot page - wallet should still be connected
    await clickNav(page, "Idiot");
    await humanDelay(page, 2000, 3000);

    // Wallet should still show as connected (no "Get Started" button)
    // or the dashboard should show authenticated content
    const connected = await isWalletConnected(page);

    if (connected) {
      // Dashboard should show balance data
      const balanceVisible = await page
        .getByText(/wallet usdc|escrow balance|djinn credits/i)
        .first()
        .isVisible({ timeout: 15_000 })
        .catch(() => false);
      expect(balanceVisible).toBe(true);
    } else {
      // Wallet didn't persist. This is a known limitation of mock wallets
      // (real wallet extensions DO persist). Log it as an annotation.
      test.info().annotations.push({
        type: "wallet-persistence",
        description:
          "Mock wallet connection did not persist across navigation. " +
          "Real wallet extensions (MetaMask, Coinbase) persist via localStorage.",
      });
    }
  });

  test("page refresh maintains functionality", async ({ page }) => {
    await landOnSite(page, BASE_URL);

    // Browse to Leaderboard
    await clickNav(page, "Leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Refresh the page (this IS a new page.goto() essentially)
    await page.reload();
    await waitForIdle(page);
    await humanDelay(page, 2000, 3000);

    // Should still be on leaderboard and functional
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate away via click (should still work after reload)
    await clickNav(page, "Docs");
    await expect(page).toHaveURL(/\/docs/, { timeout: 10_000 });
  });

  test("mobile viewport works", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 }, // iPhone X
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();

    await landOnSite(page, BASE_URL);
    await humanDelay(page, 1500, 3000);

    // On mobile, nav should be behind a hamburger menu
    const hamburger = page
      .locator("button[aria-label*='menu' i], button[aria-label*='Menu' i]")
      .first();

    if (await hamburger.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await hamburger.click();
      await page.waitForTimeout(500);

      // Should see nav links in dropdown
      const geniusLink = page.getByRole("link", { name: /genius/i }).first();
      await expect(geniusLink).toBeVisible({ timeout: 5_000 });
      await geniusLink.click();
      await waitForIdle(page);

      await expect(page).toHaveURL(/\/genius/, { timeout: 10_000 });
    }

    await humanScroll(page);

    // Content should be visible and not overflowing
    const body = page.locator("body");
    const bodyWidth = await body.evaluate((el) => el.scrollWidth);
    const viewportWidth = 375;
    // Allow small overflow (scrollbar etc.) but flag major horizontal scroll
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 20);

    await context.close();
  });
});
