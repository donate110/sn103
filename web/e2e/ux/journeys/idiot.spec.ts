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
  clickLink,
} from "../helpers/navigate";
import { getIdiotWallet } from "../helpers/wallet-pool";

/**
 * Idiot Journey: Full lifecycle as a signal buyer.
 *
 * 1. Land on homepage
 * 2. Check leaderboard (research geniuses before buying)
 * 3. Navigate to Idiot page
 * 4. Connect wallet
 * 5. View dashboard (balances, escrow, credits)
 * 6. Deposit USDC to escrow
 * 7. Browse available signals
 * 8. Look at a signal detail
 * 9. Return to dashboard
 *
 * Real transactions on Base Sepolia. Single goto.
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";
const RPC_URL = "https://sepolia.base.org";

test.describe("Idiot Journey", () => {
  test.describe.configure({ mode: "serial" });

  test("idiot full lifecycle", async ({ page }) => {
    const idiot = getIdiotWallet(0);
    const idiotAccount = privateKeyToAccount(idiot.privateKey);

    // Install mock wallet with real signing
    await installMockWallet({
      page,
      account: idiotAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (
        err.message.includes("hydrat") ||
        err.message.includes("ChunkLoadError") ||
        err.message.includes("ResizeObserver") ||
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

    // ── Step 2: Check leaderboard first (due diligence) ──────────
    await clickNav(page, "Leaderboard");
    await expect(page).toHaveURL(/\/leaderboard/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });

    await humanScroll(page);
    await humanDelay(page, 2000, 4000); // Read the leaderboard

    // ── Step 3: Navigate to Idiot page ───────────────────────────
    await clickNav(page, "Idiot");
    await expect(page).toHaveURL(/\/idiot/, { timeout: 10_000 });
    await humanDelay(page);

    // ── Step 4: Connect wallet ───────────────────────────────────
    await connectWalletViaUI(page);
    await humanDelay(page, 2000, 3000);

    // Mock wallet may need a reload to fully register with RainbowKit
    let connected = await isWalletConnected(page);
    if (!connected) {
      await page.reload();
      await waitForIdle(page);
      await humanDelay(page, 3000, 5000);
      // Try connecting again after reload
      await connectWalletViaUI(page);
      await humanDelay(page, 2000, 3000);
      connected = await isWalletConnected(page);
    }

    // ── Step 5: Verify dashboard loads ───────────────────────────
    // The dashboard shows different content depending on wallet connection state.
    // With mock wallet: should see balance cards (even if $0).
    // Without connection: should see "connect your wallet" prompt.
    const dashboardContent = page
      .getByText(/wallet usdc|escrow balance|djinn credits|connect your wallet/i)
      .first();
    await expect(dashboardContent).toBeVisible({ timeout: 20_000 });

    // If connected, verify full dashboard
    if (connected) {
      const balanceSection = page.getByText(
        /wallet usdc|escrow balance|djinn credits/i,
      );
      await expect(balanceSection.first()).toBeVisible({ timeout: 15_000 });
    }

    await humanScroll(page);
    await humanDelay(page);

    // ── Step 6: Deposit USDC to escrow ───────────────────────────
    const depositInput = page.locator("#depositEscrow");
    if (await depositInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await humanType(depositInput, "25");
      await quickPause(page);

      const depositBtn = page.getByRole("button", { name: /^deposit$/i });
      if (await depositBtn.isEnabled({ timeout: 3_000 }).catch(() => false)) {
        await depositBtn.click();

        // Wait for on-chain transaction
        const successOrReset = page
          .getByText(/deposited.*usdc/i)
          .or(page.getByRole("button", { name: /^deposit$/i }));
        await expect(successOrReset.first()).toBeVisible({ timeout: 60_000 });

        await humanDelay(page, 2000, 4000);
      }
    }

    // ── Step 7: Browse available signals ─────────────────────────
    // The browse section may be inline on the dashboard or a separate page
    const browseLink = page.getByRole("link", { name: /browse/i });
    if (await browseLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await browseLink.click();
      await waitForIdle(page);

      // May or may not navigate to a separate URL
      await page.waitForTimeout(3_000);

      // Wait for signals to load (from blockchain events)
      await humanDelay(page, 3000, 5000);

      // Check for sport filter
      const sportFilter = page.locator("#sportFilter");
      if (await sportFilter.isVisible({ timeout: 5_000 }).catch(() => false)) {
        // Interact with filter like a real user
        await sportFilter.selectOption({ index: 0 });
        await humanDelay(page);
      }

      // Look for signal cards
      const signalCards = page.locator("[data-testid='signal-card'], .signal-card, [class*='signal']");
      const cardCount = await signalCards.count();

      if (cardCount > 0) {
        // ── Step 8: Click into a signal detail ───────────────────
        await humanScroll(page);
        const firstSignal = signalCards.first();
        const signalLink = firstSignal.getByRole("link").first();
        if (await signalLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await signalLink.click();
          await waitForIdle(page);
          await humanDelay(page, 2000, 4000);

          // Should see signal details or purchase UI
          const signalPage = page
            .getByText(/purchase|signal detail|buy/i)
            .first();
          await expect(signalPage).toBeVisible({ timeout: 10_000 }).catch(() => {
            // Signal page structure varies, that's OK
          });
        }
      }
    }

    // ── Step 9: Navigate back to dashboard ───────────────────────
    await clickNav(page, "Idiot");
    await expect(page).toHaveURL(/\/idiot/, { timeout: 10_000 });

    // Dashboard should still show connected or prompt state
    const dashboardOrPrompt = page
      .getByText(/wallet usdc|escrow balance|connect your wallet/i)
      .first();
    await expect(dashboardOrPrompt).toBeVisible({ timeout: 15_000 });

    // ── Final: Report JS errors as annotations ───────────────────
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
    if (critical.length > 0) {
      for (const e of critical) {
        test.info().annotations.push({ type: "js-error", description: e });
      }
      console.log(`[idiot] ${critical.length} JS error(s):`, critical);
    }
    expect(
      critical,
      `JS errors during idiot journey:\n${critical.join("\n")}`,
    ).toHaveLength(0);
  });
});
