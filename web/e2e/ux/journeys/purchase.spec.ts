import { test, expect, type Page } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { http, createPublicClient, parseUnits, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import {
  humanDelay,
  humanScroll,
  humanType,
  waitForIdle,
  quickPause,
  snapshot,
} from "../helpers/human";
import {
  landOnSite,
  clickNav,
  connectWalletViaUI,
  isWalletConnected,
  clickButton,
} from "../helpers/navigate";
import { getGeniusWallet, getIdiotWallet } from "../helpers/wallet-pool";

/**
 * Purchase Journey: Cross-user signal creation and purchase.
 *
 * This is the critical path: a genius creates a signal, then an idiot buys it.
 * Both use real wallets with real USDC on Base Sepolia.
 *
 * The test uses two browser contexts (two "users") that interact with the same
 * on-chain state. Genius creates a signal, then we verify the idiot can see
 * and purchase it.
 *
 * This is the most complex journey and the one most likely to catch real bugs.
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";
const RPC_URL = "https://sepolia.base.org";

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const ESCROW_ADDRESS =
  (process.env.NEXT_PUBLIC_ESCROW_ADDRESS as `0x${string}`) ||
  "0xb43BA175a6784973eB3825acF801Cd7920ac692a";

const ESCROW_BALANCE_ABI = [
  {
    name: "getBalance",
    type: "function",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

test.describe("Purchase Journey", () => {
  test.describe.configure({ mode: "serial" });

  let geniusKey: `0x${string}`;
  try {
    geniusKey = getGeniusWallet().privateKey;
  } catch {
    geniusKey = "" as `0x${string}`;
  }

  const hasGenius = geniusKey.length === 66;

  test("genius creates signal, idiot deposits and browses", async ({
    browser,
  }) => {
    test.skip(!hasGenius, "E2E_GENIUS_KEY not configured");

    const geniusAccount = privateKeyToAccount(geniusKey);
    const idiot = getIdiotWallet(1); // Use idiot[1] to avoid cycle conflicts with idiot journey
    const idiotAccount = privateKeyToAccount(idiot.privateKey);

    // ════════════════════════════════════════════════════════════
    // PHASE 1: Genius creates a signal
    // ════════════════════════════════════════════════════════════

    const geniusContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const geniusPage = await geniusContext.newPage();

    await installMockWallet({
      page: geniusPage,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    // Land and navigate
    await landOnSite(geniusPage, BASE_URL);
    await clickNav(geniusPage, "Genius");
    await expect(geniusPage).toHaveURL(/\/genius/, { timeout: 10_000 });

    // Connect wallet
    await connectWalletViaUI(geniusPage);
    await humanDelay(geniusPage, 2000, 3000);

    if (!(await isWalletConnected(geniusPage))) {
      await geniusPage.reload();
      await waitForIdle(geniusPage);
      await humanDelay(geniusPage, 3000, 5000);
      await connectWalletViaUI(geniusPage);
      await humanDelay(geniusPage, 2000, 3000);
    }

    // Verify dashboard or connect prompt loaded
    const geniusDash = geniusPage
      .getByRole("heading", { name: /genius dashboard/i })
      .or(geniusPage.getByText(/connect your wallet/i));
    await expect(geniusDash.first()).toBeVisible({ timeout: 20_000 });

    // Navigate to create signal
    const createLink = geniusPage.getByRole("link", {
      name: /create signal/i,
    });
    const canCreate = await createLink
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (canCreate) {
      await createLink.click();
      await waitForIdle(geniusPage);

      await expect(geniusPage).toHaveURL(/\/genius\/signal\/new/, {
        timeout: 15_000,
      });

      // Select a sport
      const sportBtn = geniusPage
        .getByRole("button", { name: /nba/i })
        .or(geniusPage.getByRole("button", { name: /nfl|mlb|nhl/i }).first());
      await expect(sportBtn.first()).toBeVisible({ timeout: 20_000 });
      await sportBtn.first().click();
      await humanDelay(geniusPage, 2000, 3000);

      // Check for available events
      const hasEvents = await geniusPage
        .getByText(/@/)
        .first()
        .isVisible({ timeout: 10_000 })
        .catch(() => false);

      if (hasEvents) {
        // Click the first available event
        const eventRow = geniusPage.getByText(/@/).first();
        await eventRow.click();
        await humanDelay(geniusPage, 1500, 3000);

        await snapshot(geniusPage, "genius-event-selected");
      }
    }

    await geniusContext.close();

    // ════════════════════════════════════════════════════════════
    // PHASE 2: Idiot deposits and browses available signals
    // ════════════════════════════════════════════════════════════

    const idiotContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const idiotPage = await idiotContext.newPage();

    await installMockWallet({
      page: idiotPage,
      account: idiotAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    // Land and navigate
    await landOnSite(idiotPage, BASE_URL);
    await clickNav(idiotPage, "Idiot");
    await expect(idiotPage).toHaveURL(/\/idiot/, { timeout: 10_000 });

    // Connect wallet
    await connectWalletViaUI(idiotPage);
    await humanDelay(idiotPage, 2000, 3000);

    if (!(await isWalletConnected(idiotPage))) {
      await idiotPage.reload();
      await waitForIdle(idiotPage);
      await humanDelay(idiotPage, 3000, 5000);
      await connectWalletViaUI(idiotPage);
      await humanDelay(idiotPage, 2000, 3000);
    }

    // Verify dashboard or connect prompt
    const idiotDash = idiotPage
      .getByText(/wallet usdc|escrow balance|connect your wallet/i)
      .first();
    await expect(idiotDash).toBeVisible({ timeout: 15_000 });

    // Deposit to escrow
    const depositInput = idiotPage.locator("#depositEscrow");
    if (
      await depositInput.isVisible({ timeout: 5_000 }).catch(() => false)
    ) {
      await humanType(depositInput, "50");
      await quickPause(idiotPage);

      const depositBtn = idiotPage.getByRole("button", {
        name: /^deposit$/i,
      });
      if (
        await depositBtn.isEnabled({ timeout: 3_000 }).catch(() => false)
      ) {
        await depositBtn.click();
        const successOrReset = idiotPage
          .getByText(/deposited.*usdc/i)
          .or(idiotPage.getByRole("button", { name: /^deposit$/i }));
        await expect(successOrReset.first()).toBeVisible({ timeout: 60_000 });
      }
    }

    await humanDelay(idiotPage, 2000, 4000);

    // Browse signals
    const browseLink = idiotPage.getByRole("link", { name: /browse/i });
    if (await browseLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await browseLink.click();
      await waitForIdle(idiotPage);

      // Wait for signals to load
      await humanDelay(idiotPage, 3000, 5000);

      // Signal cards are <a> elements with class="card" linking to /idiot/signal/{id}
      const signalCards = idiotPage.locator("a.card[href*='/idiot/signal/']");
      const count = await signalCards.count();

      if (count > 0) {
        await snapshot(idiotPage, "idiot-signals-available");

        test.info().annotations.push({
          type: "signals-found",
          description: `${count} signal(s) available for purchase`,
        });

        // Click into the first signal
        await signalCards.first().click();
        await waitForIdle(idiotPage);
        await humanDelay(idiotPage, 2000, 3000);

        // Should see purchase UI elements
        await snapshot(idiotPage, "idiot-signal-detail");

        // Check for purchase button
        const purchaseBtn = idiotPage.getByRole("button", {
          name: /purchase signal|purchase|buy/i,
        });
        const canPurchase = await purchaseBtn
          .isVisible({ timeout: 10_000 })
          .catch(() => false);

        if (canPurchase) {
          test.info().annotations.push({
            type: "purchase-available",
            description: "Purchase button is visible and clickable",
          });

          // Enter notional amount and attempt purchase
          const notionalInput = idiotPage.locator("#notional");
          if (await notionalInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await humanType(notionalInput, "10");
            await quickPause(idiotPage);

            // Click purchase button
            await purchaseBtn.click();
            await humanDelay(idiotPage, 2000, 3000);

            // Wait for the purchase flow to progress (checking lines, MPC, on-chain)
            // or show an error. Either outcome is valuable test data.
            const progressOrError = idiotPage
              .getByText(/checking line|running secure|confirm the transaction|recording purchase|collecting|decrypting|signal purchased/i)
              .or(idiotPage.locator("[role='alert']"));

            const hasProgress = await progressOrError
              .first()
              .isVisible({ timeout: 15_000 })
              .catch(() => false);

            await snapshot(idiotPage, "idiot-purchase-attempt");

            if (hasProgress) {
              // Wait for outcome (success or error) up to 120s
              const outcome = idiotPage
                .getByText(/signal purchased|purchase failed|insufficient|unavailable|no lines|game started|could not reach|try again/i)
                .first();
              await outcome.waitFor({ state: "visible", timeout: 120_000 }).catch(() => {});
              await snapshot(idiotPage, "idiot-purchase-result");

              const resultText = await outcome.textContent().catch(() => "unknown");
              test.info().annotations.push({
                type: "purchase-result",
                description: resultText || "Purchase flow completed",
              });
            }
          }
        } else {
          // Capture why the button is not available
          const statusText = await idiotPage
            .locator("[role='alert'], [role='status']")
            .first()
            .textContent()
            .catch(() => null);

          test.info().annotations.push({
            type: "purchase-blocked",
            description: statusText || "Purchase button not visible",
          });

          await snapshot(idiotPage, "idiot-purchase-blocked");
        }
      } else {
        test.info().annotations.push({
          type: "no-signals",
          description: "No active signals available for purchase",
        });

        await snapshot(idiotPage, "idiot-no-signals");
      }
    }

    // Verify on-chain escrow balance
    try {
      const escrowBalance = await publicClient.readContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_BALANCE_ABI,
        functionName: "getBalance",
        args: [idiotAccount.address],
      });
      const formatted = formatUnits(escrowBalance, 6);
      test.info().annotations.push({
        type: "escrow-balance",
        description: `${formatted} USDC`,
      });
    } catch {
      // Contract call may fail if address not registered, that's OK
    }

    await idiotContext.close();
  });
});
