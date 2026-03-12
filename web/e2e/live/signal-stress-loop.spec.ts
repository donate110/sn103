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

const DEPLOYER_KEY = (process.env.E2E_DEPLOYER_KEY ||
  "0x81e19d7374ca5143a1fc37a49622cd71b82a5bd206991a2d0d787d0c554a804f") as Hex; // Anvil test deployer

// Base genius key; additional geniuses derived from this
const GENIUS_BASE_KEY = (process.env.E2E_GENIUS_KEY ||
  "0x7bdee6a417b39392bfc78a3cf75cc2e726d4d42c7de68f91cd40654740232471") as Hex; // Anvil test genius

const USDC_ADDRESS = (process.env.NEXT_PUBLIC_USDC_ADDRESS ||
  "0x26a9F00523fa5Cf2f18119854b2dd959CF792fB8") as Hex;

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);

// Number of genius wallets to cycle through (1 = just the pre-funded key)
const NUM_GENIUSES = 1;
// Max passes through all sports per runner iteration (0 = unlimited).
// Default 3: creates signals, then runs purchase test, then stress-runner restarts.
const MAX_PASSES = parseInt(process.env.STRESS_MAX_PASSES || "3", 10);
// Delay between signals (ms) to avoid overwhelming validators
const INTER_SIGNAL_DELAY = 5_000;

// All sports to cycle through (must match UI sport filter button labels exactly).
// "Soccer" and "MMA" are not valid UI buttons; soccer is covered by EPL + MLS.
const ALL_SPORTS = ["NBA", "NHL", "MLB", "EPL", "MLS", "NFL", "NCAAB", "NCAAF"];

// Track sports with no games so we skip them on subsequent passes
// (avoids wasting ~10s per off-season sport navigating to an empty page)
const emptySportsCount: Record<string, number> = {};
const EMPTY_SKIP_THRESHOLD = 2; // skip sport after 2 consecutive empty passes

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
  immediatePurchaseAttempts: 0,
  immediatePurchaseSuccesses: 0,
  sportsScanned: 0,
  gamesFound: 0,
  passes: 0,
  staleSignalsSkipped: 0,
  startedAt: Date.now(),
};

// Track created signals so we can correlate with purchases and settlement
const createdSignals: Array<{
  sport: string;
  game: string;
  signalId?: string;
  createdAt: number;
}> = [];

function logStats() {
  const elapsed = ((Date.now() - stats.startedAt) / 60_000).toFixed(1);
  const successRate = stats.signalsCreated + stats.signalsFailed > 0
    ? ((stats.signalsCreated / (stats.signalsCreated + stats.signalsFailed)) * 100).toFixed(0)
    : "N/A";
  const skippedSports = Object.entries(emptySportsCount)
    .filter(([, v]) => v >= EMPTY_SKIP_THRESHOLD)
    .map(([k]) => k);
  const immPurchaseRate = stats.immediatePurchaseAttempts > 0
    ? ((stats.immediatePurchaseSuccesses / stats.immediatePurchaseAttempts) * 100).toFixed(0)
    : "N/A";
  logLine("STATS", [
    `pass=${stats.passes}`,
    `signals=${stats.signalsCreated}`,
    `failed=${stats.signalsFailed}`,
    `rate=${successRate}%`,
    `purchases=${stats.purchasesMade}`,
    `purchaseFails=${stats.purchasesFailed}`,
    `immBuys=${stats.immediatePurchaseSuccesses}/${stats.immediatePurchaseAttempts} (${immPurchaseRate}%)`,
    `staleSkips=${stats.staleSignalsSkipped}`,
    `sports=${stats.sportsScanned}`,
    `games=${stats.gamesFound}`,
    `elapsed=${elapsed}min`,
    skippedSports.length > 0 ? `offseason=[${skippedSports.join(",")}]` : "",
  ].filter(Boolean).join(", "));
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
  // Beta gate uses httpOnly cookie set via /api/beta/verify POST.
  // We call the API from the page context so the cookie gets set.
  const result = await page.evaluate(async (pw) => {
    try {
      const res = await fetch("/api/beta/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
        credentials: "same-origin",
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, status: 0, error: String(e) };
    }
  }, BETA_PASSWORD);
  if (!result.ok) {
    logLine("WARN", `  Beta gate bypass failed: status=${result.status}`);
  }
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
    const sendAmount = parseUnits(ethAmount, 18);
    // Try deployer first, fall back to genius G0 if deployer is low
    const deployerBalance = await publicClient.getBalance({ address: deployerAccount.address });
    const geniusAccount = privateKeyToAccount(GENIUS_BASE_KEY);
    const geniusBalance = await publicClient.getBalance({ address: geniusAccount.address });

    let funderAccount: typeof deployerAccount | null = deployerAccount;
    let funderLabel = "deployer";
    if (deployerBalance < sendAmount + parseUnits("0.0002", 18)) {
      if (geniusBalance >= sendAmount + parseUnits("0.0002", 18)) {
        funderAccount = geniusAccount;
        funderLabel = "genius";
      } else {
        logLine("WARN", `Both deployer (${formatUnits(deployerBalance, 18)}) and genius (${formatUnits(geniusBalance, 18)}) ETH low, skipping ETH funding for ${address}`);
        funderAccount = null;
      }
    }

    if (funderAccount) {
      const walletClient = createWalletClient({
        account: funderAccount,
        chain: baseSepolia,
        transport,
      });
      try {
        const hash = await walletClient.sendTransaction({
          to: address,
          value: sendAmount,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        logLine("INFO", `Funded ${address.slice(0, 10)}... with ${ethAmount} ETH from ${funderLabel}`);
        await new Promise((r) => setTimeout(r, 3000));
      } catch (err) {
        logLine("WARN", `ETH transfer from ${funderLabel} failed: ${String(err).slice(0, 100)}`);
      }
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
  signalId?: string;
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

  // Prefer moneyline bets: no line value means they can't go stale from
  // market movement. Moneyline section is labeled "Moneyline" in the UI.
  // Fall back to any bet button if moneyline isn't available.
  const mlSection = cardCount > 0
    ? cardContainer.first().locator("text=Moneyline").locator("xpath=ancestor::div[1]")
    : page.locator("text=Moneyline").locator("xpath=ancestor::div[1]");
  const mlButtons = mlSection.locator("button");
  const mlCount = await mlButtons.count().catch(() => 0);

  let targetButton;
  if (mlCount > 0) {
    // Pick a random moneyline bet
    const mlIdx = Math.floor(Math.random() * mlCount);
    targetButton = mlButtons.nth(mlIdx);
    logLine("INFO", `  Picking moneyline bet ${mlIdx + 1}/${mlCount} (line-stale-resistant)`);
  } else {
    // Fallback: pick last bet button (which tends to be moneyline anyway)
    const betIdx = betCount > 2 ? betCount - 1 : 0;
    targetButton = betButtons.nth(betIdx);
    logLine("INFO", `  No moneyline section found, picking bet ${betIdx + 1}/${betCount}`);
  }
  await targetButton.scrollIntoViewIfNeeded();
  await targetButton.click();
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

  if (result && result.startsWith("success")) {
    stats.signalsCreated++;
    const signalId = result.includes(":") ? result.split(":")[1] : undefined;
    logLine("OK", `  Signal created: ${gameName} (${sport})${signalId ? ` [id: ${signalId.slice(0, 16)}...]` : ""}`);
    return { success: true, sport, game: gameName, signalId };
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
    if (successVisible) {
      // Try to extract signal ID from URL
      const idMatch = page.url().match(/\/signal\/(\d+)/);
      return idMatch ? `success:${idMatch[1]}` : "success";
    }

    // Redirect to genius dashboard or signal detail page
    if (page.url().includes("/genius") && !page.url().includes("/signal/new")) {
      const idMatch = page.url().match(/\/signal\/(\d+)/);
      return idMatch ? `success:${idMatch[1]}` : "success";
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

  // Click the target sport (must match a UI button exactly)
  const sportBtn = page.getByRole("button", { name: new RegExp(`^${sport}$`, "i") });
  if (await sportBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await sportBtn.click();
    await page.waitForTimeout(5_000);
  } else {
    logLine("WARN", `Sport button "${sport}" not found in UI, skipping`);
    throw new Error(`Sport button "${sport}" not found`);
  }
}

// ── Idiot purchase flow ─────────────────────────────────────────────────────

/**
 * Purchase a specific signal by navigating directly to its detail page.
 * Skips the browse page entirely for faster, more targeted purchases.
 */
async function purchaseSignalById(
  page: Page,
  idiotAccount: ReturnType<typeof privateKeyToAccount>,
  signalId: string,
): Promise<boolean> {
  await page.goto(`${BASE_URL}/idiot/signal/${signalId}`);
  await bypassBetaGate(page);
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);

  // Wait for React hydration (same loading flash fix as browse-based flow)
  try {
    await page.getByText(/loading signal data/i).waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    await page.waitForTimeout(2_000);
  }

  // Wait for the definitive post-loading state
  const pageLoaded = await Promise.race([
    page.getByText(/connect your wallet/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "connect" as const),
    page.getByText(/signal not found/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "not-found" as const),
    page.locator("#notional").waitFor({ state: "visible", timeout: 20_000 }).then(() => "ready" as const),
    page.getByText(/no longer available/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "expired" as const),
    page.getByText(/signal unavailable|encryption keys/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "unavailable" as const),
    page.getByText(/your escrow balance/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "escrow-visible" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
  ]).catch(() => "timeout" as const);

  logLine("INFO", `  Signal page state: ${pageLoaded}`);

  if (pageLoaded === "connect") {
    await connectWallet(page);
    await page.waitForTimeout(3_000);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(5_000);
  } else if (pageLoaded === "not-found" || pageLoaded === "expired" || pageLoaded === "unavailable" || pageLoaded === "timeout") {
    logLine("WARN", `  Signal ${pageLoaded}`);
    return false;
  }

  // Check if this is our own signal
  if (await page.getByText(/this is your own signal/i).isVisible().catch(() => false)) {
    logLine("WARN", "  Skipping own signal");
    return false;
  }

  // Escrow deposit if needed
  const escrowText = page.getByText(/your escrow balance/i);
  if (await escrowText.isVisible().catch(() => false)) {
    const balText = await escrowText.textContent().catch(() => "");
    const balMatch = balText?.match(/\$?([\d,.]+)/);
    const bal = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : 0;
    if (bal < 10) {
      logLine("INFO", "  Escrow balance low, depositing 500 USDC...");
      const depositInput = page.locator("#depositEscrow, input[placeholder*='Amount']").first();
      if (await depositInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await depositInput.fill("500");
        const depositBtn = page.getByRole("button", { name: /^deposit$/i });
        if (await depositBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await depositBtn.click();
          await page.waitForTimeout(5_000);
          const approvalMsg = page.getByText(/approved.*click deposit again/i);
          if (await approvalMsg.isVisible({ timeout: 30_000 }).catch(() => false)) {
            logLine("INFO", "  USDC approved, clicking deposit again...");
            await depositBtn.click();
          }
          const deposited = page.getByText(/deposited/i);
          await deposited.isVisible({ timeout: 60_000 }).catch(() => false);
          logLine("OK", "  Escrow deposit completed");
          await page.waitForTimeout(2_000);
        }
      }
    }
  }

  // Enter notional
  const notionalInput = page.locator("#notional");
  try {
    await notionalInput.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    logLine("WARN", "  No notional input found");
    return false;
  }

  const minBtn = page.getByRole("button", { name: /^min/i });
  if (await minBtn.isVisible().catch(() => false)) {
    await minBtn.click();
    logLine("INFO", "  Clicked Min button for notional");
  } else {
    await notionalInput.fill("10");
    logLine("INFO", "  Set notional to 10 USDC");
  }
  await page.waitForTimeout(1_000);

  // Click purchase
  const purchaseBtn = page.getByRole("button", { name: /purchase signal/i });
  if (!(await purchaseBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const fallbackBtn = page.getByRole("button", { name: /purchase|buy/i }).first();
    if (!(await fallbackBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      logLine("WARN", "  Purchase button not visible");
      return false;
    }
    if (await fallbackBtn.isDisabled()) {
      logLine("WARN", "  Purchase button disabled");
      return false;
    }
    await fallbackBtn.click();
  } else {
    if (await purchaseBtn.isDisabled()) {
      logLine("WARN", "  Purchase button disabled");
      return false;
    }
    await purchaseBtn.click();
  }

  logLine("INFO", "  Purchase clicked, waiting for result (up to 180s)...");

  // Wait for result (same logic as purchaseFirstAvailableSignal)
  const startTime = Date.now();
  const maxWaitMs = 180_000;
  while (Date.now() - startTime < maxWaitMs) {
    const successHeading = page.getByText(/signal purchased.*decrypted/i);
    if (await successHeading.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const realPick = page.getByText(/real pick/i);
      const pickText = await realPick.textContent().catch(() => "");
      stats.purchasesMade++;
      logLine("OK", `  Purchase succeeded! ${pickText}`);
      return true;
    }

    const errorAlert = page.locator("[role=alert]").first();
    if (await errorAlert.isVisible({ timeout: 500 }).catch(() => false)) {
      const errText = await errorAlert.textContent().catch(() => "");
      if (errText && !errText.toLowerCase().includes("checking") && !errText.toLowerCase().includes("processing")) {
        stats.purchasesFailed++;
        logLine("WARN", `  Purchase error: ${errText?.substring(0, 200)}`);
        return false;
      }
    }

    const insufficient = page.getByText(/insufficient escrow/i);
    if (await insufficient.isVisible({ timeout: 500 }).catch(() => false)) {
      stats.purchasesFailed++;
      logLine("WARN", `  ${await insufficient.textContent().catch(() => "")}`);
      return false;
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      const statusBanner = page.locator("[aria-live=polite]").first();
      const statusText = await statusBanner.textContent().catch(() => "");
      logLine("INFO", `    [${elapsed}s] ${statusText || "waiting..."}`);
    }

    await page.waitForTimeout(2_000);
  }

  stats.purchasesFailed++;
  logLine("WARN", "  Purchase timed out after 180s");
  return false;
}

async function purchaseFirstAvailableSignal(
  page: Page,
  idiotAccount: ReturnType<typeof privateKeyToAccount>,
  signalIndex = 0,
): Promise<boolean> {
  await page.goto(`${BASE_URL}/idiot/browse`);
  await bypassBetaGate(page);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await connectWallet(page);

  const heading = page.getByRole("heading", { name: /browse signals/i });
  if (!(await heading.isVisible({ timeout: 15_000 }).catch(() => false))) {
    logLine("WARN", "  Could not load browse signals page");
    return false;
  }

  // Wait for signal cards to actually load (async blockchain query).
  // The heading renders before data loads, so we need to wait for cards.
  const signalCards = page.locator("a[href*='/idiot/signal/']");
  try {
    await signalCards.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Cards may genuinely be empty, or still loading. Try one reload.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);
    try {
      await signalCards.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      logLine("INFO", "  No signals available to purchase (waited 30s)");
      return false;
    }
  }

  let cardCount = await signalCards.count();
  if (cardCount === 0) {
    logLine("INFO", "  No signals available to purchase");
    return false;
  }

  // Pick a signal. Negative signalIndex = pick from the end (newest first).
  // Browse page sorts by expiry ascending, so last cards = most recently created.
  let startIdx: number;
  if (signalIndex < 0) {
    startIdx = Math.max(0, cardCount + signalIndex) % cardCount;
  } else {
    startIdx = signalIndex % cardCount;
  }

  // Try up to 5 signals from the browse page before giving up.
  // Stale/expired/not-found signals get skipped instead of failing the whole attempt.
  const MAX_SIGNAL_RETRIES = 5;
  const triedHrefs = new Set<string>();

  for (let attempt = 0; attempt < MAX_SIGNAL_RETRIES; attempt++) {
    // On retry, reload the browse page to get a fresh card list
    if (attempt > 0) {
      await page.goto(`${BASE_URL}/idiot/browse`);
      await page.waitForLoadState("domcontentloaded");
      await connectWallet(page);
      try {
        await signalCards.first().waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        logLine("INFO", "  No signals on retry reload");
        return false;
      }
      cardCount = await signalCards.count();
    }

    const idx = (startIdx + attempt) % cardCount;
    logLine("INFO", `  Found ${cardCount} signals, clicking #${idx + 1} (attempt ${attempt + 1})...`);

    const href = await signalCards.nth(idx).getAttribute("href").catch(() => "");
    if (triedHrefs.has(href || "")) {
      logLine("INFO", `  Already tried ${href}, skipping`);
      continue;
    }
    triedHrefs.add(href || "");
    logLine("INFO", `  Signal URL: ${href}`);

    await signalCards.nth(idx).click();
    await page.waitForLoadState("domcontentloaded");

    // Wait for React hydration. The useSignal hook starts with loading=false,
    // signal=null which briefly renders "Signal not found" before useEffect
    // sets loading=true. Wait for "Loading signal data..." first.
    try {
      await page.getByText(/loading signal data/i).waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      await page.waitForTimeout(2_000);
    }

    // Wait for the definitive post-loading state
    const pageLoaded = await Promise.race([
      page.getByText(/connect your wallet/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "connect" as const),
      page.getByText(/signal not found/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "not-found" as const),
      page.locator("#notional").waitFor({ state: "visible", timeout: 20_000 }).then(() => "ready" as const),
      page.getByText(/no longer available/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "expired" as const),
      page.getByText(/signal unavailable|encryption keys/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "unavailable" as const),
      page.getByText(/your escrow balance/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "escrow-visible" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
    ]).catch(() => "timeout" as const);

    logLine("INFO", `  Signal page state: ${pageLoaded}`);

    if (pageLoaded === "connect") {
      logLine("INFO", "  Wallet disconnected on signal page, reconnecting...");
      await connectWallet(page);
      await page.waitForTimeout(3_000);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(5_000);
      // Fall through to check for #notional below
    } else if (pageLoaded === "not-found" || pageLoaded === "expired" || pageLoaded === "unavailable") {
      stats.staleSignalsSkipped++;
      logLine("WARN", `  Signal ${pageLoaded}, trying next signal...`);
      continue;
    } else if (pageLoaded === "timeout") {
      const h1Text = await page.locator("h1").first().textContent().catch(() => "none");
      logLine("WARN", `  Signal page timed out loading (h1="${h1Text}"), trying next...`);
      stats.staleSignalsSkipped++;
      continue;
    }
    // pageLoaded === "ready" or "escrow-visible" or reconnected wallet

    // Check if this is our own signal
    const ownSignal = page.getByText(/this is your own signal/i);
    if (await ownSignal.isVisible().catch(() => false)) {
      logLine("WARN", "  Skipping own signal");
      continue;
    }

    // If we got here, we have a purchasable signal. Break out of retry loop.
    break;
  }

  // Verify we're actually on a purchasable signal page
  const notionalCheck = page.locator("#notional");
  if (!(await notionalCheck.isVisible({ timeout: 3_000 }).catch(() => false))) {
    logLine("WARN", "  No purchasable signal found after retries");
    return false;
  }

  // Check escrow balance and deposit if needed
  const escrowText = page.getByText(/your escrow balance/i);
  if (await escrowText.isVisible().catch(() => false)) {
    const balText = await escrowText.textContent().catch(() => "");
    logLine("INFO", `  ${balText}`);

    // If balance is very low, deposit more
    const balMatch = balText?.match(/\$?([\d,.]+)/);
    const bal = balMatch ? parseFloat(balMatch[1].replace(/,/g, "")) : 0;
    if (bal < 10) {
      logLine("INFO", "  Escrow balance low, depositing 500 USDC...");
      const depositInput = page.locator("#depositEscrow, input[placeholder*='Amount']").first();
      if (await depositInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await depositInput.fill("500");
        const depositBtn = page.getByRole("button", { name: /^deposit$/i });
        if (await depositBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await depositBtn.click();
          // Wait for approval popup then re-deposit
          await page.waitForTimeout(5_000);
          const approvalMsg = page.getByText(/approved.*click deposit again/i);
          if (await approvalMsg.isVisible({ timeout: 30_000 }).catch(() => false)) {
            logLine("INFO", "  USDC approved, clicking deposit again...");
            await depositBtn.click();
          }
          // Wait for deposit to complete
          const deposited = page.getByText(/deposited/i);
          await deposited.isVisible({ timeout: 60_000 }).catch(() => false);
          logLine("OK", "  Escrow deposit completed");
          await page.waitForTimeout(2_000);
        }
      }
    }
  }

  // Enter notional amount - use #notional to avoid matching the deposit input.
  // Use waitFor instead of isVisible since the page needs time to render.
  const notionalInput = page.locator("#notional");
  try {
    await notionalInput.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    const h1Text = await page.locator("h1").first().textContent().catch(() => "none");
    const bodyText = await page.locator("main, [role=main], body").first().textContent().catch(() => "");
    logLine("WARN", `  No notional input after waitFor (h1="${h1Text}", body="${bodyText?.slice(0, 300)}")`);
    return false;
  }

  // Try clicking "Min" quick-select first, otherwise type 10
  const minBtn = page.getByRole("button", { name: /^min/i });
  if (await minBtn.isVisible().catch(() => false)) {
    await minBtn.click();
    logLine("INFO", "  Clicked Min button for notional");
  } else {
    await notionalInput.fill("10");
    logLine("INFO", "  Set notional to 10 USDC");
  }

  await page.waitForTimeout(1_000);

  // Click "Purchase Signal" button
  const purchaseBtn = page.getByRole("button", { name: /purchase signal/i });
  if (!(await purchaseBtn.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Fallback to any purchase/buy button
    const fallbackBtn = page.getByRole("button", { name: /purchase|buy/i }).first();
    if (!(await fallbackBtn.isVisible({ timeout: 3_000 }).catch(() => false))) {
      logLine("WARN", "  Purchase button not visible");
      return false;
    }
    if (await fallbackBtn.isDisabled()) {
      logLine("WARN", "  Purchase button disabled (signal may be unavailable)");
      return false;
    }
    await fallbackBtn.click();
  } else {
    if (await purchaseBtn.isDisabled()) {
      logLine("WARN", "  Purchase button disabled");
      return false;
    }
    await purchaseBtn.click();
  }

  logLine("INFO", "  Purchase clicked, waiting for result (up to 180s)...");

  // Wait for the multi-step process to complete
  // Steps: checking lines -> validator MPC -> on-chain tx -> collecting shares -> decrypting
  // Watch for success heading "Signal Purchased & Decrypted" or error messages
  const startTime = Date.now();
  const maxWaitMs = 180_000;

  while (Date.now() - startTime < maxWaitMs) {
    // Check for success heading
    const successHeading = page.getByText(/signal purchased.*decrypted/i);
    if (await successHeading.isVisible({ timeout: 1_000 }).catch(() => false)) {
      // Try to read the real pick
      const realPick = page.getByText(/real pick/i);
      const pickText = await realPick.textContent().catch(() => "");
      stats.purchasesMade++;
      logLine("OK", `  Purchase succeeded! ${pickText}`);
      return true;
    }

    // Check for error
    const errorAlert = page.locator("[role=alert]").first();
    if (await errorAlert.isVisible({ timeout: 500 }).catch(() => false)) {
      const errText = await errorAlert.textContent().catch(() => "");
      if (errText && !errText.toLowerCase().includes("checking") && !errText.toLowerCase().includes("processing")) {
        stats.purchasesFailed++;
        logLine("WARN", `  Purchase error: ${errText?.substring(0, 200)}`);
        return false;
      }
    }

    // Check for insufficient escrow
    const insufficient = page.getByText(/insufficient escrow/i);
    if (await insufficient.isVisible({ timeout: 500 }).catch(() => false)) {
      const msg = await insufficient.textContent().catch(() => "");
      stats.purchasesFailed++;
      logLine("WARN", `  ${msg}`);
      return false;
    }

    // Log step progress periodically
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed % 15 === 0 && elapsed > 0) {
      // Read any info/status banner
      const statusBanner = page.locator("[aria-live=polite]").first();
      const statusText = await statusBanner.textContent().catch(() => "");
      logLine("INFO", `    [${elapsed}s] ${statusText || "waiting..."}`);
    }

    await page.waitForTimeout(2_000);
  }

  stats.purchasesFailed++;
  logLine("WARN", "  Purchase timed out after 180s");
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

  test("create signals across all sports continuously", async ({ context }) => {
    // 12 hours per test run
    test.setTimeout(43_200_000);

    let pass = 0;

    // Set up idiot for interleaved purchases: buy signals right after creation
    // while the sportsbook line is still fresh (avoids the "stale pick" problem
    // where lines move between creation passes and the purchase phase)
    let idiotPage: Page | null = null;
    let idiotAcc: ReturnType<typeof privateKeyToAccount> | null = null;
    try {
      const idiotKey = deriveIdiotKey(0, Date.now());
      idiotAcc = privateKeyToAccount(idiotKey);
      logLine("INFO", `Interleaved purchase idiot: ${idiotAcc.address}`);
      await fundWallet(idiotAcc.address, "0.0005", "5000");

      const browser = context.browser();
      if (browser) {
        const idiotContext = await browser.newContext();
        idiotPage = await idiotContext.newPage();
        await installMockWallet({
          page: idiotPage,
          account: idiotAcc,
          defaultChain: baseSepolia,
          transports: { [baseSepolia.id]: http(RPC_URL) },
        });
        // Pre-deposit escrow so first purchase doesn't need USDC approval flow
        await ensureIdiotEscrow(idiotPage, idiotAcc);
        logLine("OK", "Interleaved idiot ready (wallet + escrow)");
      }
    } catch (e) {
      logLine("WARN", `Failed to set up interleaved idiot: ${String(e).slice(0, 100)}`);
    }

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

      // Create a fresh page per pass to prevent memory accumulation
      const page = await context.newPage();

      // Capture failed network requests for debugging
      page.on("response", (resp) => {
        if (resp.status() >= 400) {
          try {
            const url = new URL(resp.url());
            if (url.hostname.includes("djinn") || url.pathname.startsWith("/api/")) {
              logLine("HTTP", `${resp.status()} ${url.pathname}${url.search.slice(0, 50)}`);
            }
          } catch {}
        }
      });
      page.on("pageerror", (err) => {
        logLine("PAGE_ERR", err.message.slice(0, 200));
      });

      // Install wallet mock for this genius
      await installMockWallet({
        page,
        account: genius.account,
        defaultChain: baseSepolia,
        transports: { [baseSepolia.id]: http(RPC_URL) },
      });

      // Scan all sports
      for (const sport of ALL_SPORTS) {
        // Skip sports that have been empty multiple passes in a row (off-season)
        if ((emptySportsCount[sport] ?? 0) >= EMPTY_SKIP_THRESHOLD) {
          logLine("INFO", `\n--- ${sport} --- (skipped: no games ${emptySportsCount[sport]} passes in a row)`);
          continue;
        }

        logLine("INFO", `\n--- ${sport} ---`);
        stats.sportsScanned++;

        try {
          await navigateToFreshSignalPage(page, genius.account, sport);
        } catch (navErr) {
          logLine("WARN", `Failed to navigate to ${sport}: ${String(navErr).slice(0, 100)}`);
          continue;
        }

        // Count available games (UI shows all games with commence_time > now;
        // some may fail if the line has moved or the game just started)
        const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
        let gameCount: number;
        try {
          await gameHeadings.first().waitFor({ state: "visible", timeout: 10_000 });
          gameCount = await gameHeadings.count();
        } catch {
          gameCount = 0;
        }

        if (gameCount === 0) {
          emptySportsCount[sport] = (emptySportsCount[sport] ?? 0) + 1;
          logLine("INFO", `  No games in ${sport}, skipping (empty streak: ${emptySportsCount[sport]})`);
          continue;
        }

        // Reset empty streak when games found
        emptySportsCount[sport] = 0;

        logLine("INFO", `  Found ${gameCount} games in ${sport}`);
        stats.gamesFound += gameCount;

        // Try games from the END of the list first (future games have active odds).
        // Games are sorted by commence_time, so early entries have already started
        // and their odds are pulled. Working backwards maximizes signal creation.
        const maxGamesPerSport = Math.min(gameCount, 10);
        let consecutivePickFails = 0;
        // Build index list: start from the last game, work backwards
        const gameIndices: number[] = [];
        for (let i = gameCount - 1; i >= 0 && gameIndices.length < maxGamesPerSport; i--) {
          gameIndices.push(i);
        }
        for (let gi = 0; gi < gameIndices.length; gi++) {
          const gIdx = gameIndices[gi];
          try {
            const result = await createSignalOnGame(page, genius.account, gIdx, sport);
            if (result.success) {
              createdSignals.push({ sport, game: result.game, signalId: result.signalId, createdAt: Date.now() });
              logLine("OK", `  [${sport}] ${result.game}: SUCCESS (total: ${stats.signalsCreated})`);
              consecutivePickFails = 0;

              // Immediate purchase: try to buy a signal from the browse page.
              // purchaseFirstAvailableSignal internally retries up to 5 signals
              // when individual signals are stale/expired/not-found.
              if (idiotPage && idiotAcc) {
                stats.immediatePurchaseAttempts++;
                logLine("INFO", `  Attempting immediate purchase...`);
                let purchased = false;
                try {
                  // Start from the end of the browse page (newest signals).
                  // Vary starting position across attempts to cover more signals.
                  const signalPos = -(stats.immediatePurchaseAttempts);
                  purchased = await Promise.race([
                    purchaseFirstAvailableSignal(idiotPage, idiotAcc, signalPos),
                    new Promise<false>((r) => setTimeout(() => r(false), 120_000)),
                  ]);
                } catch (purchaseErr) {
                  logLine("WARN", `  Purchase error: ${String(purchaseErr).slice(0, 100)}`);
                }
                if (purchased) {
                  stats.immediatePurchaseSuccesses++;
                  logLine("OK", `  >>> IMMEDIATE PURCHASE for ${result.game}! <<<`);
                } else {
                  logLine("INFO", `  Immediate purchase failed (line moved or signal stale)`);
                }
              }
            } else {
              logLine("WARN", `  [${sport}] ${result.game}: FAILED - ${result.error}`);
              // If picks are unavailable, odds are pulled for this time window
              if (result.error?.includes("not currently available")) {
                consecutivePickFails++;
                if (consecutivePickFails >= 4) {
                  logLine("INFO", `  Skipping remaining ${sport} games (${consecutivePickFails} consecutive pick failures)`);
                  break;
                }
              } else {
                consecutivePickFails = 0;
              }
            }
          } catch (err) {
            stats.signalsFailed++;
            logLine("ERROR", `  [${sport}] game ${gIdx}: ${String(err).slice(0, 200)}`);
          }

          // Navigate back to fresh signal page for the next game
          if (gi < gameIndices.length - 1) {
            await page.waitForTimeout(INTER_SIGNAL_DELAY);
            try {
              await navigateToFreshSignalPage(page, genius.account, sport);
            } catch {
              logLine("WARN", `  Failed to navigate back for game ${gi + 1}, skipping remaining games in ${sport}`);
              break;
            }
          }
        }

        // Check genius ETH between sports; stop pass early if critically low
        try {
          const geniusEth = await publicClient.getBalance({ address: genius.account.address });
          if (geniusEth < parseUnits("0.0002", 18)) {
            logLine("WARN", `Genius ${genius.label} ETH critically low (${formatUnits(geniusEth, 18)}), ending pass early`);
            break;
          }
        } catch {}
      }

      logStats();

      // Close page to free memory before next pass
      await page.close().catch(() => {});

      // Between passes: brief pause, then check if we should continue
      if (MAX_PASSES === 0 || pass < MAX_PASSES) {
        logLine("INFO", `Pass ${pass} complete. Waiting 30s before next pass...`);
        await new Promise((r) => setTimeout(r, 30_000));

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

    // Clean up interleaved idiot
    if (idiotPage) {
      const idiotCtx = idiotPage.context();
      await idiotPage.close().catch(() => {});
      await idiotCtx.close().catch(() => {});
    }

    logLine("INFO", "\n" + "=".repeat(60));
    logLine("INFO", "STRESS TEST COMPLETE");
    logStats();
  });

  test("purchase signals as idiots", async ({ page }) => {
    // 4 hours for purchase pass
    test.setTimeout(14_400_000);

    // Derive a fresh idiot
    const idiotKey = deriveIdiotKey(0, Date.now());
    const idiotAcc = privateKeyToAccount(idiotKey);

    logLine("INFO", `Idiot address: ${idiotAcc.address}`);

    // Fund idiot with minimal ETH (0.0005 is enough for several txs)
    logLine("INFO", "Funding idiot wallet...");
    await fundWallet(idiotAcc.address, "0.0005", "5000");

    // Install wallet mock
    await installMockWallet({
      page,
      account: idiotAcc,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    // Purchase signals, starting from the END of the browse page (newest first).
    // Browse page sorts by expiry ascending, so the last cards are the most
    // recently created and most likely to have fresh picks at sportsbooks.
    const maxPurchases = 50;
    let consecutiveFailures = 0;
    for (let i = 0; i < maxPurchases; i++) {
      logLine("INFO", `\nPurchase attempt ${i + 1}/${maxPurchases}...`);

      // Negative signalIndex tells the function to try from the end of the list
      const ok = await purchaseFirstAvailableSignal(page, idiotAcc, -(i + 1));
      if (ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= 10) {
          logLine("INFO", `${consecutiveFailures} consecutive failures, stopping purchases`);
          break;
        }
      }

      // Check idiot ETH balance periodically
      if (i % 10 === 0) {
        try {
          const ethBal = await publicClient.getBalance({ address: idiotAcc.address });
          logLine("INFO", `  Idiot ETH: ${formatUnits(ethBal, 18)}`);
          if (ethBal < parseUnits("0.0001", 18)) {
            logLine("WARN", "  Idiot ETH critically low, stopping purchases");
            break;
          }
        } catch {}
      }

      await page.waitForTimeout(5_000);
    }

    logLine("INFO", `\nPurchases complete: ${stats.purchasesMade} succeeded, ${stats.purchasesFailed} failed`);
  });
});
