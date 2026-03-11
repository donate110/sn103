import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import {
  http,
  createPublicClient,
  createWalletClient,
  parseUnits,
  formatUnits,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { ethers } from "ethers";
import { createHash } from "crypto";
import { appendFileSync, mkdirSync } from "fs";

/**
 * High-throughput signal creation stress test.
 *
 * Creates signals across ALL sports with available games, using multiple
 * genius wallets. Then purchases each signal as idiots. Loops continuously
 * to generate maximum signal volume for stress testing the protocol.
 *
 * Run with:
 *   cd web && npx playwright test --config=playwright.stress.config.ts
 */

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? "https://www.djinn.gg";
const RPC_URL = "https://sepolia.base.org";
const BETA_PASSWORD = process.env.E2E_BETA_PASSWORD || "djinnybaby";

const DEPLOYER_KEY = (process.env.E2E_DEPLOYER_KEY || // Anvil test deployer
  "0x81e19d7374ca5143a1fc37a49622cd71b82a5bd206991a2d0d787d0c554a804f") as Hex;

// Base genius key; additional geniuses derived from this
const GENIUS_BASE_KEY = (process.env.E2E_GENIUS_KEY || // Anvil test genius
  "0x7bdee6a417b39392bfc78a3cf75cc2e726d4d42c7de68f91cd40654740232471") as Hex;

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ||
  "0x26a9F00523fa5Cf2f18119854b2dd959CF792fB8") as Hex;

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);

// Number of genius wallets to cycle through (1 = just the pre-funded key)
const NUM_GENIUSES = 1;
// Max passes through all sports (0 = unlimited)
const MAX_PASSES = parseInt(process.env.STRESS_MAX_PASSES || "0", 10);
// Delay between signals (ms) to avoid overwhelming validators
const INTER_SIGNAL_DELAY = 5_000;

// All sports to cycle through (in order of game availability likelihood)
const ALL_SPORTS = ["NBA", "NHL", "MLB", "EPL", "MLS", "NFL", "NCAAB", "NCAAF", "Soccer", "MMA"];

const LOG_FILE = "test-results/signal-stress.log";

// ── Logging ─────────────────────────────────────────────────────────────────

try { mkdirSync("test-results", { recursive: true }); } catch {}

function logLine(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const stats = {
  signalsCreated: 0,
  signalsFailed: 0,
  purchasesMade: 0,
  purchasesFailed: 0,
  sportsScanned: 0,
  gamesFound: 0,
  passes: 0,
  startedAt: Date.now(),
};

function logStats() {
  const elapsed = ((Date.now() - stats.startedAt) / 60_000).toFixed(1);
  logLine("STATS", [
    `pass=${stats.passes}`,
    `signals=${stats.signalsCreated}`,
    `failed=${stats.signalsFailed}`,
    `purchases=${stats.purchasesMade}`,
    `purchaseFails=${stats.purchasesFailed}`,
    `sports=${stats.sportsScanned}`,
    `games=${stats.gamesFound}`,
    `elapsed=${elapsed}min`,
  ].join(", "));
}

// ── Wallet derivation ───────────────────────────────────────────────────────

function deriveGeniusKey(idx: number): Hex {
  if (idx === 0) return GENIUS_BASE_KEY;
  const raw = ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "string", "uint256"],
      [GENIUS_BASE_KEY, "stress-genius", BigInt(idx)],
    ),
  );
  return raw as Hex;
}

function deriveIdiotKey(geniusIdx: number, pass: number): Hex {
  // Unique idiot per genius per pass to avoid CycleSignalLimitReached
  const raw = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "uint256", "uint256"],
      ["stress-idiot", BigInt(geniusIdx), BigInt(pass), BigInt(Date.now())],
    ),
  );
  return raw as Hex;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function bypassBetaGate(page: Page) {
  await page.evaluate((pw) => {
    localStorage.setItem("djinn-beta-access", "true");
    localStorage.setItem("djinn-beta-password", pw);
  }, BETA_PASSWORD);
}

async function connectWallet(page: Page) {
  const connectBtn = page.getByRole("button", { name: /get started/i });
  if (await connectBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await connectBtn.click();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const mockBtn = page.getByRole("button", { name: /mock/i });
        await mockBtn.waitFor({ state: "visible", timeout: 5_000 });
        await page.waitForTimeout(500);
        await mockBtn.click({ timeout: 5_000 });
        break;
      } catch {
        if (attempt === 2) break;
        await page.waitForTimeout(1_000);
      }
    }
    await page.waitForTimeout(2_000);
  }
}

async function injectMasterSeed(
  page: Page,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const signature = await account.signTypedData({
    domain: { name: "Djinn", version: "1" },
    types: { KeyDerivation: [{ name: "purpose", type: "string" }] },
    primaryType: "KeyDerivation",
    message: { purpose: "signal-keys-v1" },
  });

  const sigBytes = Buffer.from(signature.replace(/^0x/, ""), "hex");
  const hash = createHash("sha256").update(sigBytes).digest();
  const seedHex = hash.toString("hex");

  await page.evaluate((hex) => {
    sessionStorage.setItem("djinn:masterSeed", hex);
  }, seedHex);
}

async function fundWallet(address: Hex, ethAmount = "0.001", usdcAmount = "10000") {
  const targetBalance = await publicClient.getBalance({ address });
  if (targetBalance < parseUnits("0.0005", 18)) {
    // Check deployer has enough ETH before attempting transfer
    const deployerBalance = await publicClient.getBalance({ address: deployerAccount.address });
    const sendAmount = parseUnits(ethAmount, 18);
    if (deployerBalance < sendAmount + parseUnits("0.0002", 18)) {
      logLine("WARN", `Deployer ETH low (${formatUnits(deployerBalance, 18)} ETH), skipping ETH funding for ${address}`);
    } else {
      const walletClient = createWalletClient({
        account: deployerAccount,
        chain: baseSepolia,
        transport,
      });
      const hash = await walletClient.sendTransaction({
        to: address,
        value: sendAmount,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // Mint USDC (minting is free, only costs gas)
  const ethersProvider = new ethers.JsonRpcProvider(RPC_URL);
  const ethersWallet = new ethers.Wallet(DEPLOYER_KEY, ethersProvider);
  const usdcContract = new ethers.Contract(
    USDC_ADDRESS,
    ["function mint(address to, uint256 amount) external"],
    ethersWallet,
  );
  try {
    const nonce = await ethersProvider.getTransactionCount(ethersWallet.address, "latest");
    const tx = await usdcContract.mint(address, parseUnits(usdcAmount, 6), { nonce });
    await tx.wait();
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    logLine("WARN", `USDC mint failed for ${address}: ${String(err).slice(0, 100)}`);
  }
}

async function screenshotStep(page: Page, name: string) {
  try {
    await page.screenshot({
      path: `test-results/stress-${name}-${Date.now()}.png`,
      fullPage: true,
    });
  } catch {}
}

// ── Signal creation for one game ────────────────────────────────────────────

interface SignalResult {
  success: boolean;
  sport: string;
  game: string;
  error?: string;
}

async function createSignalOnGame(
  page: Page,
  account: ReturnType<typeof privateKeyToAccount>,
  gameIdx: number,
  sport: string,
): Promise<SignalResult> {
  const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
  const gameCount = await gameHeadings.count();
  if (gameIdx >= gameCount) {
    return { success: false, sport, game: "N/A", error: "game index out of range" };
  }

  const targetH3 = gameHeadings.nth(gameIdx);
  const gameName = (await targetH3.textContent()) || `game-${gameIdx}`;
  logLine("INFO", `  Attempting signal on: ${gameName}`);

  // Expand game card
  await targetH3.scrollIntoViewIfNeeded();
  await targetH3.click();
  await page.waitForTimeout(3_000);

  // Find bet buttons
  let cardContainer = page.locator(".card").filter({ has: targetH3 });
  let cardCount = await cardContainer.count();

  if (cardCount === 0) {
    cardContainer = targetH3.locator("xpath=ancestor::div[contains(@class,'card')]");
    cardCount = await cardContainer.count();
  }

  const betButtons = cardCount > 0
    ? cardContainer.first().locator("button").filter({
        hasNotText: /^(NBA|NFL|MLB|NHL|Soccer|NCAAF|NCAAB|EPL|MLS|MMA)$/,
      })
    : page.locator("button").filter({ hasText: /[+-]\d+/ });

  const betCount = await betButtons.count();
  if (betCount === 0) {
    await targetH3.click(); // collapse
    await page.waitForTimeout(500);
    return { success: false, sport, game: gameName, error: "no bet buttons" };
  }

  // Pick a moneyline bet (last button tends to be moneyline)
  const betIdx = betCount > 2 ? betCount - 1 : 0;
  await betButtons.nth(betIdx).scrollIntoViewIfNeeded();
  await betButtons.nth(betIdx).click();
  await page.waitForTimeout(2_000);

  // Advance through Review Lines
  const reviewHeading = page.getByText("Review Lines");
  if (!(await reviewHeading.isVisible({ timeout: 10_000 }).catch(() => false))) {
    return { success: false, sport, game: gameName, error: "did not advance to Review step" };
  }

  const nextBtn = page.getByRole("button", { name: /next.*configure|continue/i });
  if (await nextBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await nextBtn.click();
    await page.waitForTimeout(1_000);
  }

  // Configure step
  const configHeading = page.getByText("Configure Signal");
  if (!(await configHeading.isVisible({ timeout: 10_000 }).catch(() => false))) {
    return { success: false, sport, game: gameName, error: "did not reach Configure step" };
  }

  const submitBtn = page.getByRole("button", { name: /create signal|set up encryption/i });
  if (!(await submitBtn.isVisible({ timeout: 10_000 }).catch(() => false))) {
    return { success: false, sport, game: gameName, error: "submit button not visible" };
  }

  const btnText = await submitBtn.textContent();
  if (btnText?.toLowerCase().includes("encryption")) {
    // Seed lost, re-inject
    await injectMasterSeed(page, account);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    return { success: false, sport, game: gameName, error: "seed lost, reinjected" };
  }

  // Submit
  await submitBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await submitBtn.click({ force: true });
  logLine("INFO", `  Clicked Create Signal for ${gameName}`);

  // Wait for result (up to 120s)
  const result = await waitForSignalResult(page);

  if (result === "success") {
    stats.signalsCreated++;
    logLine("OK", `  Signal created: ${gameName} (${sport})`);
    return { success: true, sport, game: gameName };
  }

  if (result && result.startsWith("error:")) {
    const errMsg = result.slice(6);
    stats.signalsFailed++;
    logLine("WARN", `  Signal failed: ${errMsg}`);
    return { success: false, sport, game: gameName, error: errMsg };
  }

  stats.signalsFailed++;
  logLine("WARN", `  Signal timeout for ${gameName}`);
  return { success: false, sport, game: gameName, error: "timeout" };
}

async function waitForSignalResult(page: Page): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3_000);

    // Success
    const successVisible = await page
      .getByText(/Signal Created|Signal Committed|Shares Distributed/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (successVisible) return "success";

    // Redirect to genius dashboard
    if (page.url().includes("/genius") && !page.url().includes("/signal/new")) {
      return "success";
    }

    // Error alert
    const errorAlert = page.locator("[role=alert]").first();
    if (await errorAlert.isVisible().catch(() => false)) {
      const alertText = await errorAlert.textContent().catch(() => "");
      if (alertText && alertText.length > 10) {
        return `error:${alertText}`;
      }
    }

    // Red error text
    const redErrorText = page.locator(".bg-red-50 .text-red-600").first();
    if (await redErrorText.isVisible().catch(() => false)) {
      const errText = await redErrorText.textContent().catch(() => "");
      if (errText && errText.length > 5) {
        return `error:${errText}`;
      }
    }

    if (i % 5 === 0) {
      logLine("INFO", `    [${i * 3}s] Still waiting... URL: ${page.url()}`);
    }
  }
  return null;
}

async function navigateToFreshSignalPage(
  page: Page,
  account: ReturnType<typeof privateKeyToAccount>,
  sport: string,
) {
  await page.goto(`${BASE_URL}/genius/signal/new`);
  await injectMasterSeed(page, account);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);
  await page.waitForTimeout(3_000);

  // Click the target sport
  const sportBtn = page.getByRole("button", { name: new RegExp(`^${sport}$`, "i") });
  if (await sportBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await sportBtn.click();
    await page.waitForTimeout(5_000);
  }
}

// ── Idiot purchase flow ─────────────────────────────────────────────────────

async function purchaseFirstAvailableSignal(
  page: Page,
  idiotAccount: ReturnType<typeof privateKeyToAccount>,
): Promise<boolean> {
  await page.goto(`${BASE_URL}/idiot/browse`);
  await bypassBetaGate(page);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);
  await page.waitForTimeout(3_000);

  const heading = page.getByRole("heading", { name: /browse signals/i });
  if (!(await heading.isVisible({ timeout: 15_000 }).catch(() => false))) {
    logLine("WARN", "  Could not load browse signals page");
    return false;
  }

  await page.waitForTimeout(3_000);

  // Look for signal cards
  const signalCards = page.locator("a[href*='/idiot/signal/']");
  const cardCount = await signalCards.count();
  if (cardCount === 0) {
    logLine("INFO", "  No signals available to purchase");
    return false;
  }

  logLine("INFO", `  Found ${cardCount} signals, clicking first...`);
  await signalCards.first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3_000);

  // Check for purchase form
  const purchaseForm = page.getByText(/purchase|buy|notional/i).first();
  if (!(await purchaseForm.isVisible({ timeout: 5_000 }).catch(() => false))) {
    logLine("WARN", "  No purchase form visible on signal detail page");
    return false;
  }

  // Enter notional
  const notionalInput = page
    .locator("input[type=number], input[placeholder*='amount'], input[placeholder*='notional'], input[placeholder*='USDC']")
    .first();
  if (await notionalInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await notionalInput.fill("10");
  }

  // Click purchase
  const purchaseBtn = page.getByRole("button", { name: /purchase|buy/i }).first();
  if (!(await purchaseBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    logLine("WARN", "  Purchase button not visible");
    return false;
  }

  await purchaseBtn.click();

  // Wait for purchase result (up to 120s)
  const outcome = page.getByText(/purchased|decrypted|error|failed|insufficient/i).first();
  const visible = await outcome.isVisible({ timeout: 120_000 }).catch(() => false);
  if (visible) {
    const text = await outcome.textContent().catch(() => "");
    if (text?.toLowerCase().includes("purchased") || text?.toLowerCase().includes("decrypted")) {
      stats.purchasesMade++;
      logLine("OK", `  Purchase succeeded: ${text}`);
      return true;
    }
    stats.purchasesFailed++;
    logLine("WARN", `  Purchase failed: ${text}`);
    return false;
  }

  stats.purchasesFailed++;
  logLine("WARN", "  Purchase timed out");
  return false;
}

// ── Genius deposit collateral ───────────────────────────────────────────────

async function ensureGeniusCollateral(
  page: Page,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  await page.goto(`${BASE_URL}/genius`);
  await bypassBetaGate(page);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);

  const dashHeading = page.getByRole("heading", { name: /genius dashboard/i });
  if (!(await dashHeading.isVisible({ timeout: 15_000 }).catch(() => false))) {
    return;
  }

  // Try to deposit collateral
  const depositInput = page.locator("#depositCollateral");
  if (await depositInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await depositInput.fill("1000");
    const depositBtn = page.getByRole("button", { name: /^deposit$/i });
    if (await depositBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await depositBtn.click();
      // Wait for completion
      const success = page
        .getByText(/deposited.*usdc/i)
        .or(page.getByRole("button", { name: /^deposit$/i }));
      await expect(success.first()).toBeVisible({ timeout: 60_000 }).catch(() => {});
      logLine("OK", "  Genius collateral deposited");
    }
  }
}

// ── Idiot deposit escrow ────────────────────────────────────────────────────

async function ensureIdiotEscrow(
  page: Page,
  idiotAcc: ReturnType<typeof privateKeyToAccount>,
) {
  await page.goto(`${BASE_URL}/idiot`);
  await bypassBetaGate(page);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);

  await page.waitForTimeout(3_000);

  const depositInput = page.locator("#depositEscrow");
  if (await depositInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await depositInput.fill("500");
    const depositBtn = page.getByRole("button", { name: /^deposit$/i });
    if (await depositBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await depositBtn.click();
      const success = page
        .getByText(/deposited.*usdc/i)
        .or(page.getByRole("button", { name: /^deposit$/i }));
      await expect(success.first()).toBeVisible({ timeout: 60_000 }).catch(() => {});
      logLine("OK", "  Idiot escrow deposited");
    }
  }
}

// ── Main test ───────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" });

test.describe("Signal stress loop", () => {
  // Build genius accounts
  const geniusAccounts = Array.from({ length: NUM_GENIUSES }, (_, i) => ({
    key: deriveGeniusKey(i),
    account: privateKeyToAccount(deriveGeniusKey(i)),
    label: `G${i}`,
  }));

  test("fund all genius wallets", async () => {
    test.setTimeout(300_000);
    for (const g of geniusAccounts) {
      // Check if genius already has enough USDC; skip funding if so
      const usdcBal = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: [{ name: "balanceOf", type: "function", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }],
        functionName: "balanceOf",
        args: [g.account.address],
      });
      if (usdcBal > parseUnits("1000", 6)) {
        logLine("INFO", `${g.label} already has $${formatUnits(usdcBal, 6)} USDC, skipping funding`);
        continue;
      }
      logLine("INFO", `Funding ${g.label} (${g.account.address})...`);
      await fundWallet(g.account.address);
      logLine("OK", `${g.label} funded`);
    }
  });

  test("deposit collateral for all geniuses", async ({ page }) => {
    test.setTimeout(600_000);
    for (const g of geniusAccounts) {
      logLine("INFO", `Depositing collateral for ${g.label}...`);
      await installMockWallet({
        page,
        account: g.account,
        defaultChain: baseSepolia,
        transports: { [baseSepolia.id]: http(RPC_URL) },
      });
      await ensureGeniusCollateral(page, g.account);
    }
  });

  test("create signals across all sports continuously", async ({ page, context }) => {
    // 12 hours per test run
    test.setTimeout(43_200_000);

    // Capture page errors for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        logLine("PAGE", msg.text().slice(0, 200));
      }
    });
    page.on("pageerror", (err) => {
      logLine("PAGE_ERR", err.message.slice(0, 200));
    });

    let pass = 0;

    while (MAX_PASSES === 0 || pass < MAX_PASSES) {
      pass++;
      stats.passes = pass;
      logLine("INFO", `\n${"=".repeat(60)}`);
      logLine("INFO", `PASS ${pass} starting`);
      logLine("INFO", `${"=".repeat(60)}`);

      // Rotate through geniuses
      const gIdx = (pass - 1) % NUM_GENIUSES;
      const genius = geniusAccounts[gIdx];
      logLine("INFO", `Using ${genius.label} (${genius.account.address})`);

      // Install wallet mock for this genius
      await installMockWallet({
        page,
        account: genius.account,
        defaultChain: baseSepolia,
        transports: { [baseSepolia.id]: http(RPC_URL) },
      });

      // Scan all sports
      for (const sport of ALL_SPORTS) {
        logLine("INFO", `\n--- ${sport} ---`);
        stats.sportsScanned++;

        try {
          await navigateToFreshSignalPage(page, genius.account, sport);
        } catch (navErr) {
          logLine("WARN", `Failed to navigate to ${sport}: ${String(navErr).slice(0, 100)}`);
          continue;
        }

        // Count available games
        const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
        let gameCount: number;
        try {
          await gameHeadings.first().waitFor({ state: "visible", timeout: 10_000 });
          gameCount = await gameHeadings.count();
        } catch {
          gameCount = 0;
        }

        if (gameCount === 0) {
          logLine("INFO", `  No games in ${sport}, skipping`);
          continue;
        }

        logLine("INFO", `  Found ${gameCount} games in ${sport}`);
        stats.gamesFound += gameCount;

        // Try to create signals on each game (up to 5 per sport per pass)
        const maxGamesPerSport = Math.min(gameCount, 5);
        for (let gIdx = 0; gIdx < maxGamesPerSport; gIdx++) {
          try {
            const result = await createSignalOnGame(page, genius.account, gIdx, sport);
            if (result.success) {
              logLine("OK", `  [${sport}] ${result.game}: SUCCESS (total: ${stats.signalsCreated})`);
            } else {
              logLine("WARN", `  [${sport}] ${result.game}: FAILED - ${result.error}`);
            }
          } catch (err) {
            stats.signalsFailed++;
            logLine("ERROR", `  [${sport}] game ${gIdx}: ${String(err).slice(0, 200)}`);
          }

          // Navigate back to fresh signal page for the next game
          if (gIdx < maxGamesPerSport - 1) {
            await page.waitForTimeout(INTER_SIGNAL_DELAY);
            try {
              await navigateToFreshSignalPage(page, genius.account, sport);
            } catch {
              logLine("WARN", `  Failed to navigate back for game ${gIdx + 1}, skipping remaining games in ${sport}`);
              break;
            }
          }
        }
      }

      logStats();

      // Between passes: brief pause, then check if we should continue
      if (MAX_PASSES === 0 || pass < MAX_PASSES) {
        logLine("INFO", `Pass ${pass} complete. Waiting 30s before next pass...`);
        await page.waitForTimeout(30_000);

        // Refund genius if running low
        try {
          const ethBal = await publicClient.getBalance({ address: genius.account.address });
          if (ethBal < parseUnits("0.0003", 18)) {
            logLine("INFO", `Refunding ${genius.label}...`);
            await fundWallet(genius.account.address, "0.005", "20000");
          }
        } catch {}
      }
    }

    logLine("INFO", "\n" + "=".repeat(60));
    logLine("INFO", "STRESS TEST COMPLETE");
    logStats();
  });

  test("purchase signals as idiots", async ({ page }) => {
    // 2 hours for purchase pass
    test.setTimeout(7_200_000);

    // Derive a fresh idiot
    const idiotKey = deriveIdiotKey(0, Date.now());
    const idiotAcc = privateKeyToAccount(idiotKey);

    logLine("INFO", `Idiot address: ${idiotAcc.address}`);

    // Fund idiot
    logLine("INFO", "Funding idiot wallet...");
    await fundWallet(idiotAcc.address, "0.002", "10000");

    // Install wallet mock
    await installMockWallet({
      page,
      account: idiotAcc,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    // Deposit escrow
    await ensureIdiotEscrow(page, idiotAcc);

    // Purchase signals in a loop (wallet mock already installed above)
    const maxPurchases = 20;
    for (let i = 0; i < maxPurchases; i++) {
      logLine("INFO", `Purchase attempt ${i + 1}/${maxPurchases}...`);

      const ok = await purchaseFirstAvailableSignal(page, idiotAcc);
      if (!ok && i > 5) {
        logLine("INFO", "Multiple purchase failures, stopping purchase loop");
        break;
      }

      await page.waitForTimeout(5_000);
    }

    logLine("INFO", `Purchases complete: ${stats.purchasesMade} succeeded, ${stats.purchasesFailed} failed`);
  });
});
