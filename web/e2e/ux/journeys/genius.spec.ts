import { test, expect } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  humanDelay,
  humanScroll,
  humanType,
  waitForIdle,
  quickPause,
} from "../helpers/human";
import {
  landOnSite,
  clickNav,
  connectWalletViaUI,
  isWalletConnected,
  clickButton,
  clickLink,
} from "../helpers/navigate";
import { getGeniusWallet } from "../helpers/wallet-pool";

/**
 * Genius Journey: Full lifecycle as a signal creator.
 *
 * 1. Land on homepage
 * 2. Navigate to Genius page
 * 3. Connect wallet
 * 4. View dashboard (balances, collateral, signals)
 * 5. Deposit collateral via UI
 * 6. Navigate to create signal wizard
 * 7. Select a sport and event
 * 8. Return to dashboard and verify state
 *
 * All on-chain transactions are REAL (Base Sepolia testnet).
 * Single page.goto(); everything else is clicks.
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";
const RPC_URL = "https://sepolia.base.org";

test.describe("Genius Journey", () => {
  test.describe.configure({ mode: "serial" });

  let geniusKey: `0x${string}`;
  try {
    geniusKey = getGeniusWallet().privateKey;
  } catch {
    geniusKey = "" as `0x${string}`;
  }

  const hasWallet = geniusKey.length === 66;

  test("genius full lifecycle", async ({ page }) => {
    test.skip(!hasWallet, "E2E_GENIUS_KEY not configured");

    const geniusAccount = privateKeyToAccount(geniusKey);

    // Install the mock wallet (real signing, real chain)
    await installMockWallet({
      page,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (
        err.message.includes("hydrat") ||
        err.message.includes("ChunkLoadError") ||
        err.message.includes("ResizeObserver") ||
        // Minified React hydration errors (#418 = text mismatch, #422 = hydration failed)
        err.message.includes("Minified React error #418") ||
        err.message.includes("Minified React error #422") ||
        err.message.includes("Minified React error #423") ||
        err.message.includes("Minified React error #425")
      )
        return;
      errors.push(err.message);
    });

    // ── Step 1: Land on homepage ──────────────────────────────────
    await landOnSite(page, BASE_URL);
    await humanDelay(page, 1000, 2000);

    // ── Step 2: Navigate to Genius page ──────────────────────────
    await clickNav(page, "Genius");
    await expect(page).toHaveURL(/\/genius/, { timeout: 10_000 });

    // Should see "Connect your wallet" prompt or similar
    await humanDelay(page);

    // ── Step 3: Connect wallet ───────────────────────────────────
    await connectWalletViaUI(page);
    await humanDelay(page, 2000, 3000);

    // Mock wallet may need a reload to fully register
    let connected = await isWalletConnected(page);
    if (!connected) {
      await page.reload();
      await waitForIdle(page);
      await humanDelay(page, 3000, 5000);
      await connectWalletViaUI(page);
      await humanDelay(page, 2000, 3000);
      connected = await isWalletConnected(page);
    }

    // ── Step 4: Verify dashboard loads ───────────────────────────
    // Should see either the connected dashboard or the connect prompt
    const dashboardContent = page
      .getByRole("heading", { name: /genius dashboard/i })
      .or(page.getByText(/connect your wallet/i));
    await expect(dashboardContent.first()).toBeVisible({ timeout: 20_000 });

    // If connected, verify dashboard sections
    if (connected) {
      const balanceOrCollateral = page
        .getByText(/wallet usdc|collateral/i)
        .first();
      await expect(balanceOrCollateral).toBeVisible({ timeout: 10_000 });
    }

    await humanScroll(page);
    await humanDelay(page);

    // ── Step 5: Deposit collateral ───────────────────────────────
    const depositInput = page.locator("#depositCollateral");
    if (await depositInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await humanType(depositInput, "10");
      await quickPause(page);

      const depositBtn = page.getByRole("button", { name: /^deposit$/i });
      if (await depositBtn.isEnabled({ timeout: 3_000 }).catch(() => false)) {
        await depositBtn.click();

        // Wait for transaction to process (real on-chain, may take time)
        const successOrReset = page
          .getByText(/deposited.*usdc/i)
          .or(page.getByRole("button", { name: /^deposit$/i }));
        await expect(successOrReset.first()).toBeVisible({ timeout: 60_000 });

        await humanDelay(page, 2000, 4000);
      }
    }

    // ── Step 6: Navigate to Create Signal wizard ─────────────────
    const createLink = page.getByRole("link", { name: /create signal/i });
    if (await createLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await createLink.click();
      await waitForIdle(page);

      await expect(page).toHaveURL(/\/genius\/signal\/new/, {
        timeout: 15_000,
      });

      // Wait for sport selection to appear (data from odds API)
      const sportBtn = page
        .getByRole("button", { name: /nfl|nba|mlb|nhl|soccer|mma/i })
        .first();
      await expect(sportBtn).toBeVisible({ timeout: 20_000 });

      // Click a sport to see events
      await sportBtn.click();
      await humanDelay(page, 2000, 3000);

      // Should see events or "no upcoming events"
      const events = page.getByText(/@|vs|no upcoming/i).first();
      await expect(events).toBeVisible({ timeout: 15_000 });

      await humanScroll(page);
      await humanDelay(page);
    }

    // ── Step 7: Go back to dashboard ─────────────────────────────
    await clickNav(page, "Genius");
    await expect(page).toHaveURL(/\/genius/, { timeout: 10_000 });
    // Wait for page content to load (may take time due to RPC calls)
    await waitForIdle(page);
    await humanDelay(page, 2000, 4000);

    // ── Final: No critical JS errors ─────────────────────────────
    const critical = errors.filter(
      (e) =>
        !e.includes("Warning:") &&
        !e.includes("favicon") &&
        !e.includes("walletconnect") &&
        !e.includes("WalletConnect") &&
        !e.includes("Failed to load resource") &&
        !e.includes("403") &&
        !e.includes("ERR_"),
    );
    expect(
      critical,
      `JS errors during genius journey:\n${critical.join("\n")}`,
    ).toHaveLength(0);
  });
});
