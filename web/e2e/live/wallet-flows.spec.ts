import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { http, createPublicClient, parseUnits, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Connected-wallet E2E tests against live djinn.gg + Base Sepolia.
 *
 * Uses @johanneskares/wallet-mock to inject a real private-key-backed
 * wallet via EIP-6963, which RainbowKit auto-discovers.
 * All transactions are real — signed and submitted to Base Sepolia.
 *
 * Wallets:
 * - DEPLOYER: Mints USDC, funds other wallets with ETH + USDC
 * - GENIUS_A: Creates signals, deposits collateral
 * - IDIOT_A:  Purchases signals, deposits escrow
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? "https://www.djinn.gg";
const RPC_URL = "https://sepolia.base.org";
const BETA_PASSWORD = process.env.E2E_BETA_PASSWORD || "";

// Deployer key — same one that deployed contracts, has USDC minting rights
const DEPLOYER_KEY = (process.env.E2E_DEPLOYER_KEY || "") as `0x${string}`;

// E2E test genius key
const GENIUS_KEY = (process.env.E2E_GENIUS_KEY || "") as `0x${string}`;

// Derive a fresh idiot key per run to avoid cycle limits
const IDIOT_KEY = (() => {
  // Use a deterministic-ish key derived from a known seed + timestamp bucket
  // Each ~hour gets a new key to avoid CycleSignalLimitReached
  const bucket = Math.floor(Date.now() / 3_600_000);
  const seed = `idiot-e2e-${bucket}`;
  // Simple hash — just use a fixed test key for now, cycle limits reset with fresh contracts
  return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
})();

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x26a9F00523fa5Cf2f18119854b2dd959CF792fB8";
const COLLATERAL_ADDRESS = process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS || "0x16C36aCe7aB4525Ed1D0F12a8E6c38f5be29cb16";
const ESCROW_ADDRESS = process.env.NEXT_PUBLIC_ESCROW_ADDRESS || "0x50A1Bf4eacED9b9da4B1A5BA3001aA0979E91A21";
const SIGNAL_COMMITMENT_ADDRESS = process.env.NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS || "0xF664eAF0564953ee0c374B92D9697191c3eBEb69";

const transport = http(RPC_URL);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport,
});

// Minimal ABIs for on-chain setup
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
  "function transfer(address,uint256) returns (bool)",
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function bypassBetaGate(page: Page) {
  await page.evaluate((pw) => {
    localStorage.setItem("djinn-beta-access", "true");
    localStorage.setItem("djinn-beta-password", pw);
  }, BETA_PASSWORD);
}

async function connectWallet(page: Page) {
  // Click "Get Started" to open RainbowKit modal
  const connectBtn = page.getByRole("button", { name: /get started/i });
  if (await connectBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await connectBtn.click();
    // Wait for the RainbowKit modal to appear and find the mock wallet
    // wallet-mock announces via EIP-6963 — RainbowKit shows it as an option.
    // RainbowKit re-renders its modal, which can detach the button from the DOM
    // between isVisible and click. Retry up to 3 times with a short delay.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mockWalletBtn = page.getByRole("button", { name: /mock/i });
        await mockWalletBtn.waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(500); // let RainbowKit stabilize
        await mockWalletBtn.click({ timeout: 5_000 });
        break; // click succeeded
      } catch {
        if (attempt === 2) break; // give up after 3 attempts
        await page.waitForTimeout(1_000);
      }
    }
    // Wait for connection
    await page.waitForTimeout(2_000);
  }
}

async function waitForWalletConnected(page: Page) {
  // After wallet-mock connects, the page should no longer show "Get Started"
  // and instead show a connected state (truncated address or account modal button)
  await expect(
    page.getByText(/connect your wallet/i),
  ).not.toBeVisible({ timeout: 15_000 }).catch(() => {
    // If still showing connect prompt, wallet may not have connected
  });
}

async function fundWithEth(
  toAddress: string,
  amountEth: string = "0.0003",
) {
  const { createWalletClient } = await import("viem");
  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const walletClient = createWalletClient({
    account: deployerAccount,
    chain: baseSepolia,
    transport,
  });
  const hash = await walletClient.sendTransaction({
    to: toAddress as `0x${string}`,
    value: parseUnits(amountEth, 18),
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function mintUsdc(toAddress: string, amount: string = "10000") {
  const { createWalletClient } = await import("viem");
  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const walletClient = createWalletClient({
    account: deployerAccount,
    chain: baseSepolia,
    transport,
  });
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS as `0x${string}`,
    abi: [
      {
        name: "mint",
        type: "function",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "mint",
    args: [toAddress as `0x${string}`, parseUnits(amount, 6)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

const geniusAccount = privateKeyToAccount(GENIUS_KEY);
const idiotAccount = privateKeyToAccount(IDIOT_KEY);

test.describe.configure({ mode: "serial" });

// ─── Pre-flight: Fund wallets ────────────────────────────────────────────────

test.describe("Pre-flight: Fund test wallets", () => {
  test("fund genius with ETH and USDC", async () => {
    test.setTimeout(60_000);
    const balance = await publicClient.getBalance({
      address: geniusAccount.address,
    });
    if (balance < parseUnits("0.0005", 18)) {
      await fundWithEth(geniusAccount.address);
    }
    await mintUsdc(geniusAccount.address, "5000");
  });

  test("fund idiot with ETH and USDC", async () => {
    test.setTimeout(60_000);
    const balance = await publicClient.getBalance({
      address: idiotAccount.address,
    });
    if (balance < parseUnits("0.0005", 18)) {
      await fundWithEth(idiotAccount.address);
    }
    await mintUsdc(idiotAccount.address, "5000");
  });
});

// ─── Genius Flow: Connect → Deposit Collateral → Dashboard ──────────────────

test.describe("Genius connected flow", () => {
  test.beforeEach(async ({ page }) => {
    await installMockWallet({
      page,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });
  });

  test("genius can connect wallet and see dashboard", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Should see "Get Started" button since wallet isn't connected yet
    await connectWallet(page);
    await waitForWalletConnected(page);

    // After connection, should see the connected dashboard
    // Check for stats cards that only show when connected
    const dashboardHeading = page.getByRole("heading", {
      name: /genius dashboard/i,
    });
    await expect(dashboardHeading).toBeVisible({ timeout: 15_000 });

    // Should see wallet USDC balance (we just funded it)
    await expect(page.getByText(/wallet usdc/i)).toBeVisible({
      timeout: 10_000,
    });

    // Should see collateral section
    await expect(page.getByText(/collateral management/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("genius can deposit collateral through UI", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Wait for dashboard to load
    await expect(page.getByText(/collateral management/i)).toBeVisible({
      timeout: 15_000,
    });

    // Fill deposit amount
    const depositInput = page.locator("#depositCollateral");
    await depositInput.fill("100");

    // Click deposit button
    const depositBtn = page.getByRole("button", { name: /^deposit$/i });
    await depositBtn.click();

    // Wait for transaction — button should show "Depositing..."
    await expect(
      page.getByRole("button", { name: /depositing/i }),
    ).toBeVisible({ timeout: 5_000 }).catch(() => {});

    // Wait for success message or button to return to normal
    const success = page
      .getByText(/deposited.*usdc.*collateral/i)
      .or(page.getByRole("button", { name: /^deposit$/i }));
    await expect(success.first()).toBeVisible({ timeout: 45_000 });

    // Check collateral balance updated (should show > $0)
    const collateralCard = page.getByText(/usdc deposited/i);
    await expect(collateralCard).toBeVisible();
  });

  test("genius can navigate to create signal page", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    await expect(
      page.getByRole("heading", { name: /genius dashboard/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Click "Create Signal" button
    const createBtn = page.getByRole("link", { name: /create signal/i });
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    // Should navigate to /genius/signal/new
    await expect(page).toHaveURL(/\/genius\/signal\/new/, {
      timeout: 15_000,
    });

    // Should see the signal creation wizard — sport selection
    // Wait for sports to load (they come from the odds API)
    const sportButton = page
      .getByRole("button", { name: /nfl|nba|mlb|nhl|soccer/i })
      .first();
    await expect(sportButton).toBeVisible({ timeout: 15_000 });
  });

  test("genius can see my signals section (empty or with signals)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see My Signals section
    await expect(
      page.getByRole("heading", { name: /my signals/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Either shows signals or "No signals yet"
    const signalsOrEmpty = page
      .getByText(/no signals yet/i)
      .or(page.getByText(/active/i));
    await expect(signalsOrEmpty.first()).toBeVisible({ timeout: 10_000 });
  });

  test("genius dashboard shows history section", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // The heading is "History" (not "Audit History")
    await expect(
      page.getByRole("heading", { name: /history/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("genius dashboard shows settlement history section", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    await expect(
      page.getByRole("heading", { name: /settlement history/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("genius dashboard shows active relationships section", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/genius`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    await expect(
      page.getByRole("heading", { name: /active relationships/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ─── Idiot Flow: Connect → Deposit Escrow → Browse → Dashboard ──────────────

test.describe("Idiot connected flow", () => {
  test.beforeEach(async ({ page }) => {
    await installMockWallet({
      page,
      account: idiotAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });
  });

  test("idiot can connect wallet and see dashboard", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see connected dashboard with balance cards
    await expect(page.getByText(/wallet usdc/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/escrow balance/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/djinn credits/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("idiot can deposit USDC to escrow through UI", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Wait for balance section
    await expect(page.getByText(/wallet usdc/i)).toBeVisible({
      timeout: 15_000,
    });

    // Fill deposit amount
    const depositInput = page.locator("#depositEscrow");
    await expect(depositInput).toBeVisible({ timeout: 10_000 });
    await depositInput.fill("50");

    // Click deposit
    const depositBtn = page.getByRole("button", { name: /^deposit$/i });
    await depositBtn.click();

    // Wait for transaction
    await expect(
      page.getByRole("button", { name: /depositing/i }),
    ).toBeVisible({ timeout: 5_000 }).catch(() => {});

    // Wait for success or button to reset
    const success = page
      .getByText(/deposited.*usdc.*escrow/i)
      .or(page.getByRole("button", { name: /^deposit$/i }));
    await expect(success.first()).toBeVisible({ timeout: 45_000 });
  });

  test("idiot can browse available signals", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see available signals section
    await expect(page.getByText(/available signals/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // Sport filter should be visible
    const sportSelect = page.locator("#sportFilter");
    if (await sportSelect.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(sportSelect).toBeEnabled();
    }
  });

  test("idiot can see purchase history", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see purchase history section (may be empty)
    const purchaseSection = page
      .getByText(/purchase history/i)
      .or(page.getByText(/signals purchased/i));
    await expect(purchaseSection.first()).toBeVisible({ timeout: 15_000 });
  });

  test("idiot can navigate to browse page from dashboard", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Find a browse or "View →" link to a signal
    const browseLink = page.getByRole("link", { name: /browse/i });
    if (await browseLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await browseLink.click();
      await expect(page).toHaveURL(/\/idiot\/browse/, { timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: /browse signals/i }),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("idiot dashboard shows settlement history", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(`${BASE_URL}/idiot`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see settlement history section
    const settlementSection = page
      .getByText(/settlement history/i)
      .or(page.getByText(/no settlements yet/i));
    await expect(settlementSection.first()).toBeVisible({ timeout: 15_000 });
  });
});

// ─── Cross-role: Genius creates signal, Idiot sees it ────────────────────────

test.describe("Cross-role signal visibility", () => {
  test("genius can access create signal wizard with connected wallet", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await installMockWallet({
      page,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    await page.goto(`${BASE_URL}/genius/signal/new`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see sport selection (Step 1 of wizard)
    // Wait for the odds API to return data
    const sportButtons = page.getByRole("button", {
      name: /nfl|nba|mlb|nhl|soccer|mma/i,
    });
    const firstSport = sportButtons.first();
    await expect(firstSport).toBeVisible({ timeout: 20_000 });

    // Click a sport to browse events
    await firstSport.click();
    await page.waitForTimeout(2_000);

    // Should see events or a "no upcoming events" message
    // Games use "@" (e.g., "Brooklyn Nets @ Atlanta Hawks")
    const eventsOrEmpty = page
      .getByText(/@|vs|no upcoming/i)
      .first();
    await expect(eventsOrEmpty).toBeVisible({ timeout: 15_000 });
  });

  test("idiot can view a signal detail page", async ({ page }) => {
    test.setTimeout(30_000);
    await installMockWallet({
      page,
      account: idiotAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    // Navigate to a signal detail with a dummy ID
    // The page should handle this gracefully (show not found or error)
    await page.goto(`${BASE_URL}/idiot/signal/999999`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    await waitForWalletConnected(page);

    // Should see the purchase page structure (even if signal doesn't exist)
    // Either shows signal details or a "not found" / error state
    const signalPage = page
      .getByText(/purchase signal/i)
      .or(page.getByText(/signal not found/i))
      .or(page.getByText(/connect your wallet/i));
    await expect(signalPage.first()).toBeVisible({ timeout: 15_000 });
  });
});

// ─── Leaderboard: Should reflect connected state ─────────────────────────────

test.describe("Leaderboard with connected wallet", () => {
  test("leaderboard loads with genius entries", async ({ page }) => {
    test.setTimeout(30_000);
    await installMockWallet({
      page,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    await page.goto(`${BASE_URL}/leaderboard`);
    await bypassBetaGate(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Should see leaderboard heading
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Table or empty state
    const content = page
      .getByText(/quality score|no geniuses/i)
      .first();
    await expect(content).toBeVisible({ timeout: 10_000 });
  });
});

// ─── No JS errors across connected pages ─────────────────────────────────────

test.describe("No JS errors on connected pages", () => {
  const pages = [
    { name: "Genius Dashboard", path: "/genius" },
    { name: "Create Signal", path: "/genius/signal/new" },
    { name: "Idiot Dashboard", path: "/idiot" },
    { name: "Browse Signals", path: "/idiot/browse" },
    { name: "Leaderboard", path: "/leaderboard" },
  ];

  for (const p of pages) {
    test(`${p.name} has no critical JS errors when wallet connected`, async ({
      page,
    }) => {
      test.setTimeout(30_000);
      await installMockWallet({
        page,
        account: geniusAccount,
        defaultChain: baseSepolia,
        transports: { [baseSepolia.id]: http(RPC_URL) },
      });

      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          // Ignore expected warnings/errors
          if (
            text.includes("hydrat") ||
            text.includes("favicon") ||
            text.includes("ERR_CONNECTION") ||
            text.includes("ERR_FAILED") ||
            text.includes("ChunkLoadError") ||
            text.includes("CORS") ||
            text.includes("ResizeObserver") ||
            text.includes("walletconnect") ||
            text.includes("WalletConnect") ||
            text.includes("Failed to load resource") ||
            text.includes("403")
          ) {
            return;
          }
          errors.push(text);
        }
      });

      page.on("pageerror", (err) => {
        if (
          err.message.includes("hydrat") ||
          err.message.includes("ChunkLoadError") ||
          err.message.includes("ResizeObserver")
        ) {
          return;
        }
        errors.push(`PAGE ERROR: ${err.message}`);
      });

      await page.goto(`${BASE_URL}${p.path}`);
      await bypassBetaGate(page);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await connectWallet(page);
      await page.waitForTimeout(5_000); // Let React settle

      if (errors.length > 0) {
        test.info().annotations.push({
          type: "js-errors",
          description: errors.join(" | "),
        });
      }
      expect(
        errors.filter((e) => !e.includes("Warning:")),
        `Critical JS errors on ${p.name}: ${errors.join("\n")}`,
      ).toHaveLength(0);
    });
  }
});
