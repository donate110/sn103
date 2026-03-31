import { test, expect, type Page } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import {
  http,
  createPublicClient,
  createWalletClient,
  parseUnits,
  formatUnits,
  parseAbi,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { ethers } from "ethers";
import { createHash } from "crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";

/**
 * 20-Signal Benchmark: Create 20 signals as genius, purchase each as idiot.
 * Reports min/max/avg timing for creation and purchase.
 *
 * Run:
 *   cd web && npx playwright test e2e/live/twenty-signal-benchmark.spec.ts \
 *     --config=playwright.live.config.ts --project=ui \
 *     --timeout=1800000 --global-timeout=1800000 --workers=1 --retries=0
 */

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.BASE_URL ?? "https://www.djinn.gg";
const RPC_URL = "https://sepolia.base.org";

const DEPLOYER_KEY = (process.env.E2E_DEPLOYER_KEY ||
  "0x81e19d7374ca5143a1fc37a49622cd71b82a5bd206991a2d0d787d0c554a804f") as Hex;

const GENIUS_KEY = (process.env.E2E_GENIUS_KEY ||
  "0x7bdee6a417b39392bfc78a3cf75cc2e726d4d42c7de68f91cd40654740232471") as Hex;

// Live deployment contract addresses (Base Sepolia, UUPS proxies)
const USDC_ADDRESS = "0x00e8293b05dbD3732EF3396ad1483E87e7265054" as Hex;
const ESCROW_ADDRESS = "0xb43BA175a6784973eB3825acF801Cd7920ac692a" as Hex;
const COLLATERAL_ADDRESS = "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88" as Hex;

const TARGET_SIGNALS = 20;
// All sports to cycle through. Must match UI button labels exactly.
const ALL_SPORTS = ["NBA", "NHL", "MLB", "EPL", "MLS"];

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: baseSepolia, transport });

const LOG_FILE = "test-results/twenty-signal-benchmark.log";
const RESULTS_FILE = "test-results/twenty-signal-results.tsv";

try { mkdirSync("test-results", { recursive: true }); } catch {}

// Truncate log for fresh run
try { writeFileSync(LOG_FILE, ""); } catch {}

function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ── Timing data ───────────────────────────────────────────────────────────────

interface TimingEntry {
  idx: number;
  sport: string;
  game: string;
  createMs: number;
  signalId?: string;
  purchaseMs: number;
  purchaseSuccess: boolean;
  error?: string;
}

const timings: TimingEntry[] = [];

// ── Wallet helpers ────────────────────────────────────────────────────────────

const geniusAccount = privateKeyToAccount(GENIUS_KEY);

function deriveIdiotKey(idx: number): Hex {
  const raw = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "uint256"],
      ["benchmark-idiot", BigInt(idx), BigInt(Date.now())],
    ),
  );
  return raw as Hex;
}

async function injectMasterSeed(page: Page, account: ReturnType<typeof privateKeyToAccount>) {
  const signature = await account.signTypedData({
    domain: { name: "Djinn", version: "1" },
    types: { KeyDerivation: [{ name: "purpose", type: "string" }] },
    primaryType: "KeyDerivation",
    message: { purpose: "signal-keys-v1" },
  });
  const sigBytes = Buffer.from(signature.replace(/^0x/, ""), "hex");
  const hash = createHash("sha256").update(sigBytes).digest();
  await page.evaluate((hex) => {
    sessionStorage.setItem("djinn:masterSeed", hex);
  }, hash.toString("hex"));
}

async function connectWallet(page: Page) {
  const connectBtn = page.getByRole("button", { name: /get started/i });
  try {
    await connectBtn.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    return; // already connected
  }
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

async function fundWithEth(address: Hex, amount = "0.0003") {
  const balance = await publicClient.getBalance({ address });
  if (balance >= parseUnits("0.0001", 18)) return;

  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const walletClient = createWalletClient({
    account: deployerAccount,
    chain: baseSepolia,
    transport,
  });
  try {
    const hash = await walletClient.sendTransaction({
      to: address,
      value: parseUnits(amount, 18),
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log("INFO", `Funded ${address.slice(0, 10)}... with ${amount} ETH`);
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    log("WARN", `ETH funding failed: ${String(err).slice(0, 120)}`);
  }
}

async function mintUsdc(address: Hex, amount = "10000") {
  const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const bal = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  if (Number(bal) / 1e6 >= 100) return;

  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const walletClient = createWalletClient({
    account: deployerAccount,
    chain: baseSepolia,
    transport,
  });
  try {
    const hash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: parseAbi(["function mint(address to, uint256 amount) external"]),
      functionName: "mint",
      args: [address, parseUnits(amount, 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log("INFO", `Minted ${amount} USDC to ${address.slice(0, 10)}...`);
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    log("WARN", `USDC mint failed: ${String(err).slice(0, 120)}`);
  }
}

// ── Signal creation ───────────────────────────────────────────────────────────

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

  // Click the target sport button
  const sportBtn = page.getByRole("button", { name: new RegExp(`^${sport}$`, "i") });
  try {
    await sportBtn.waitFor({ state: "visible", timeout: 10_000 });
    await sportBtn.click();
    await page.waitForTimeout(5_000);
  } catch {
    throw new Error(`Sport button "${sport}" not found`);
  }
}

async function createSignalOnGame(
  page: Page,
  account: ReturnType<typeof privateKeyToAccount>,
  gameIdx: number,
  sport: string,
): Promise<{ success: boolean; signalId?: string; game: string; error?: string }> {
  const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
  const gameCount = await gameHeadings.count();
  if (gameIdx >= gameCount) {
    return { success: false, game: "N/A", error: `game index ${gameIdx} out of range (${gameCount} games)` };
  }

  const targetH3 = gameHeadings.nth(gameIdx);
  const gameName = (await targetH3.textContent()) || `game-${gameIdx}`;
  log("INFO", `  Attempting signal on: ${gameName}`);

  // Expand game card
  await targetH3.scrollIntoViewIfNeeded();
  await targetH3.click();
  await page.waitForTimeout(3_000);

  // Find moneyline bets (most stable bet type)
  let cardContainer = page.locator(".card").filter({ has: targetH3 });
  let cardCount = await cardContainer.count();
  if (cardCount === 0) {
    cardContainer = targetH3.locator("xpath=ancestor::div[contains(@class,'card')]");
    cardCount = await cardContainer.count();
  }

  // Try moneyline section first
  const mlSection = cardCount > 0
    ? cardContainer.first().locator("text=Moneyline").locator("xpath=ancestor::div[1]")
    : page.locator("text=Moneyline").locator("xpath=ancestor::div[1]");
  const mlButtons = mlSection.locator("button");
  let mlCount = await mlButtons.count().catch(() => 0);

  if (mlCount === 0) {
    // Fallback: any bet button with odds
    const betButtons = cardCount > 0
      ? cardContainer.first().locator("button").filter({ hasNotText: /^(NBA|NFL|MLB|NHL|Soccer|NCAAF|NCAAB|EPL|MLS|MMA)$/ })
      : page.locator("button").filter({ hasText: /[+-]\d+/ });
    const betCount = await betButtons.count();
    if (betCount === 0) {
      await targetH3.click(); // collapse
      return { success: false, game: gameName, error: "no bet buttons" };
    }
    await betButtons.first().click();
  } else {
    const idx = Math.floor(Math.random() * mlCount);
    await mlButtons.nth(idx).click();
  }
  await page.waitForTimeout(2_000);

  // Review Lines step
  try {
    await page.getByText("Review Lines").waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { success: false, game: gameName, error: "did not reach Review step" };
  }

  // Click Next/Continue
  const nextBtn = page.getByRole("button", { name: /next.*configure|continue/i });
  try {
    await nextBtn.waitFor({ state: "visible", timeout: 5_000 });
    await nextBtn.click();
    await page.waitForTimeout(1_000);
  } catch {
    // May auto-advance
  }

  // Configure step
  try {
    await page.getByText("Configure Signal").waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { success: false, game: gameName, error: "did not reach Configure step" };
  }

  const submitBtn = page.getByRole("button", { name: /create signal|set up encryption/i });
  try {
    await submitBtn.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { success: false, game: gameName, error: "submit button not visible" };
  }

  const btnText = await submitBtn.textContent();
  if (btnText?.toLowerCase().includes("encryption")) {
    await injectMasterSeed(page, account);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    return { success: false, game: gameName, error: "seed lost, reinjected" };
  }

  // Submit
  await submitBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await submitBtn.click({ force: true });
  log("INFO", `  Clicked Create Signal for ${gameName}`);

  // Wait for result (up to 120s)
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1_000);

    const successVisible = await page
      .getByText(/Signal Created|Signal Committed|Shares Distributed/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (successVisible) {
      const signalIdEl = page.locator("[data-signal-id]");
      const signalId = await signalIdEl.getAttribute("data-signal-id").catch(() => null);
      if (signalId) return { success: true, game: gameName, signalId };
      const idMatch = page.url().match(/\/signal\/(\d+)/);
      return { success: true, game: gameName, signalId: idMatch?.[1] };
    }

    // Redirected to genius dashboard
    if (page.url().includes("/genius") && !page.url().includes("/signal/new")) {
      const idMatch = page.url().match(/\/signal\/(\d+)/);
      return { success: true, game: gameName, signalId: idMatch?.[1] };
    }

    // Error
    const errorAlert = page.locator("[role=alert]").first();
    if (await errorAlert.isVisible().catch(() => false)) {
      const alertText = await errorAlert.textContent().catch(() => "");
      if (alertText && alertText.length > 10) {
        return { success: false, game: gameName, error: alertText.slice(0, 200) };
      }
    }

    const redError = page.locator(".bg-red-50 .text-red-600, .text-red-500").first();
    if (await redError.isVisible().catch(() => false)) {
      const errText = await redError.textContent().catch(() => "");
      if (errText && errText.length > 5) {
        return { success: false, game: gameName, error: errText.slice(0, 200) };
      }
    }

    if (i % 15 === 0 && i > 0) {
      log("INFO", `    [${i}s] Still waiting... URL: ${page.url()}`);
    }
  }

  return { success: false, game: gameName, error: "timeout after 120s" };
}

// ── Signal purchase ───────────────────────────────────────────────────────────

async function purchaseSignalById(
  page: Page,
  idiotAccount: ReturnType<typeof privateKeyToAccount>,
  signalId: string,
): Promise<{ success: boolean; error?: string }> {
  // Navigate to signal detail page with retries for RPC lag
  let pageState: string = "timeout";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      log("INFO", `  Retry load (attempt ${attempt + 1})...`);
      await page.waitForTimeout(5_000);
    }
    await page.goto(`${BASE_URL}/idiot/signal/${signalId}`);
    await page.waitForLoadState("domcontentloaded");
    await connectWallet(page);

    try {
      await page.getByText(/loading signal data/i).waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      await page.waitForTimeout(2_000);
    }

    pageState = await Promise.race([
      page.locator("#notional").waitFor({ state: "visible", timeout: 20_000 }).then(() => "ready" as const),
      page.getByText(/signal not found/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "not-found" as const),
      page.getByText(/no longer available/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "expired" as const),
      page.getByText(/your escrow balance/i).waitFor({ state: "visible", timeout: 20_000 }).then(() => "escrow-visible" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
    ]).catch(() => "timeout" as const);

    log("INFO", `  Page state: ${pageState}`);
    if (pageState !== "not-found") break;
  }

  if (pageState === "not-found" || pageState === "expired" || pageState === "timeout") {
    return { success: false, error: `page: ${pageState}` };
  }

  if (await page.getByText(/this is your own signal/i).isVisible().catch(() => false)) {
    return { success: false, error: "own signal" };
  }

  // Check escrow and deposit if needed
  let escrowOk = false;
  try {
    const bal = await publicClient.readContract({
      address: ESCROW_ADDRESS,
      abi: parseAbi(["function getBalance(address) view returns (uint256)"]),
      functionName: "getBalance",
      args: [idiotAccount.address],
    });
    if (Number(bal) / 1e6 >= 10) escrowOk = true;
  } catch {}

  if (!escrowOk) {
    log("INFO", "  Depositing 500 USDC to escrow...");
    const depositInput = page.locator("#depositEscrow, input[placeholder='Amount']").first();
    try {
      await depositInput.waitFor({ state: "visible", timeout: 5_000 });
      await depositInput.fill("500");
      const depositBtn = page.getByRole("button", { name: /^deposit$/i });
      await depositBtn.waitFor({ state: "visible", timeout: 3_000 });
      await depositBtn.click();

      // Handle two-step approve+deposit
      try {
        await page.getByText(/approved.*click deposit again/i).waitFor({ state: "visible", timeout: 30_000 });
        log("INFO", "  Approved, clicking deposit again...");
        await depositBtn.click();
      } catch { /* may not need approval */ }

      try {
        await page.getByText(/^deposited \$/i).waitFor({ state: "visible", timeout: 60_000 });
        log("OK", "  Escrow deposit OK");
      } catch {
        log("WARN", "  Deposit may not have completed");
      }
      await page.waitForTimeout(3_000);
    } catch (err) {
      return { success: false, error: `escrow deposit failed: ${String(err).slice(0, 80)}` };
    }
  }

  // After deposit, page may need a moment to reflect new balance
  await page.waitForTimeout(2_000);

  // Enter notional
  const notionalInput = page.locator("#notional");
  try {
    await notionalInput.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    // Page may have lost state after deposit; try reloading
    await page.reload({ waitUntil: "domcontentloaded" });
    await connectWallet(page);
    await page.waitForTimeout(5_000);
    try {
      await page.locator("#notional").waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      return { success: false, error: "notional input not found after reload" };
    }
  }
  await page.locator("#notional").fill("10");
  await page.waitForTimeout(1_000);

  // Click purchase -- try multiple locator strategies
  let purchaseBtn = page.getByRole("button", { name: /purchase signal/i });
  let found = await purchaseBtn.isVisible().catch(() => false);

  if (!found) {
    // Fallback: button with text content
    purchaseBtn = page.locator("button").filter({ hasText: /Purchase Signal/i });
    found = await purchaseBtn.first().isVisible().catch(() => false);
  }
  if (!found) {
    // Fallback: any submit button in the form
    purchaseBtn = page.locator("form button[type=submit]");
    found = await purchaseBtn.first().isVisible().catch(() => false);
  }

  if (!found) {
    // Take screenshot for debugging
    await page.screenshot({ path: "test-results/purchase-btn-missing.png", fullPage: true }).catch(() => {});
    return { success: false, error: "purchase button not found" };
  }

  const btnTarget = purchaseBtn.first();
  await btnTarget.scrollIntoViewIfNeeded();
  if (await btnTarget.isDisabled()) {
    const btnText = await btnTarget.textContent().catch(() => "");
    return { success: false, error: `purchase button disabled: ${btnText}` };
  }
  await btnTarget.click();

  log("INFO", "  Waiting for MPC (up to 180s)...");

  // Wait for result
  const startTime = Date.now();
  while (Date.now() - startTime < 180_000) {
    const success = await page
      .getByText(/signal purchased|decrypted/i)
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (success) return { success: true };

    // Check for terminal errors (red alerts). Ignore amber "temporarily unavailable"
    // banners, which are background share-check status, not purchase results.
    const alerts = page.locator("[role=alert]");
    const alertCount = await alerts.count().catch(() => 0);
    for (let a = 0; a < alertCount; a++) {
      const alert = alerts.nth(a);
      const errText = await alert.textContent().catch(() => "");
      if (!errText) continue;
      const lower = errText.toLowerCase();
      // Transient states: keep waiting
      if (lower.includes("checking") || lower.includes("processing")) continue;
      // Background share check status: not a purchase error, ignore
      if (lower.includes("temporarily unavailable") || lower.includes("still distributing")) continue;
      // Red error with actual purchase failure
      if (lower.includes("failed") || lower.includes("error") || lower.includes("reverted") || lower.includes("insufficient")) {
        return { success: false, error: errText.slice(0, 200) };
      }
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed % 20 === 0 && elapsed > 0) {
      const status = await page.locator("[aria-live=polite]").first().textContent().catch(() => "");
      log("INFO", `    [${elapsed}s] ${status || "waiting..."}`);
    }

    await page.waitForTimeout(2_000);
  }

  return { success: false, error: "purchase timeout 180s" };
}

// ── Main test ─────────────────────────────────────────────────────────────────

test.describe("20-Signal Benchmark", () => {
  test("create and purchase 20 signals", async ({ page, browser }) => {
    test.setTimeout(1_800_000); // 30 minutes

    log("INFO", "=== 20-Signal Benchmark Starting ===");
    log("INFO", `Target: ${TARGET_SIGNALS} signals`);

    // Pre-fund genius
    log("INFO", "Pre-funding genius wallet...");
    await fundWithEth(geniusAccount.address);
    await mintUsdc(geniusAccount.address);

    // Install wallet mock on the test page (reuse single page for genius)
    await installMockWallet({
      page,
      account: geniusAccount,
      defaultChain: baseSepolia,
      transports: { [baseSepolia.id]: http(RPC_URL) },
    });

    let created = 0;
    let purchased = 0;
    let sportIdx = 0;

    while (created < TARGET_SIGNALS) {
      const sport = ALL_SPORTS[sportIdx % ALL_SPORTS.length];
      sportIdx++;

      log("INFO", `\n=== Scanning ${sport} (created ${created}/${TARGET_SIGNALS}) ===`);

      try {
        await navigateToFreshSignalPage(page, geniusAccount, sport);
      } catch (err) {
        log("WARN", `Failed to navigate to ${sport}: ${String(err).slice(0, 100)}`);
        continue;
      }

      // Count games, work backwards (future games have active odds)
      const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
      let gameCount: number;
      try {
        await gameHeadings.first().waitFor({ state: "visible", timeout: 10_000 });
        gameCount = await gameHeadings.count();
      } catch {
        gameCount = 0;
      }

      if (gameCount === 0) {
        log("INFO", `  No games in ${sport}, skipping`);
        continue;
      }

      log("INFO", `  Found ${gameCount} games in ${sport}`);

      // Try games from end (latest commence time, most likely to have active odds)
      for (let gi = gameCount - 1; gi >= 0 && created < TARGET_SIGNALS; gi--) {
        log("INFO", `\n--- Signal ${created + 1}/${TARGET_SIGNALS} (${sport} game ${gi}) ---`);

        const createStart = Date.now();
        const result = await createSignalOnGame(page, geniusAccount, gi, sport);
        const createMs = Date.now() - createStart;

        if (!result.success || !result.signalId) {
          log("WARN", `  Creation FAILED: ${result.error} (${(createMs / 1000).toFixed(1)}s)`);

          // Re-navigate for next game (page state may be broken)
          try {
            await navigateToFreshSignalPage(page, geniusAccount, sport);
          } catch {
            break; // sport is broken, move to next
          }
          continue;
        }

        created++;
        log("OK", `  Signal #${result.signalId} created in ${(createMs / 1000).toFixed(1)}s for "${result.game}"`);

        // ── Purchase as idiot ──────────────────────────────────────────
        // Wait for validators to distribute Shamir key shares before purchasing.
        // Without this, purchase fails with "Validators are still distributing
        // encryption key shares for this signal."
        log("INFO", "  Waiting 60s for validator share distribution...");
        await new Promise((r) => setTimeout(r, 60_000));

        const idiotKey = deriveIdiotKey(created);
        const idiotAccount = privateKeyToAccount(idiotKey);
        log("INFO", `  Funding idiot ${idiotAccount.address.slice(0, 10)}...`);
        await fundWithEth(idiotAccount.address);
        await mintUsdc(idiotAccount.address);

        // New context for idiot (different wallet)
        const idiotCtx = await browser.newContext();
        const idiotPage = await idiotCtx.newPage();
        await installMockWallet({
          page: idiotPage,
          account: idiotAccount,
          defaultChain: baseSepolia,
          transports: { [baseSepolia.id]: http(RPC_URL) },
        });

        const purchaseStart = Date.now();
        const pResult = await purchaseSignalById(idiotPage, idiotAccount, result.signalId);
        const purchaseMs = Date.now() - purchaseStart;

        await idiotPage.close();
        await idiotCtx.close();

        if (pResult.success) {
          purchased++;
          log("OK", `  Purchase OK in ${(purchaseMs / 1000).toFixed(1)}s`);
        } else {
          log("WARN", `  Purchase FAILED: ${pResult.error} (${(purchaseMs / 1000).toFixed(1)}s)`);
        }

        timings.push({
          idx: created,
          sport,
          game: result.game,
          createMs,
          signalId: result.signalId,
          purchaseMs,
          purchaseSuccess: pResult.success,
          error: pResult.success ? undefined : pResult.error,
        });

        // Re-navigate for next signal
        if (created < TARGET_SIGNALS && gi > 0) {
          try {
            await navigateToFreshSignalPage(page, geniusAccount, sport);
          } catch {
            break;
          }
        }
      }

      // If we've cycled through all sports 3 times without hitting 20, stop
      if (sportIdx >= ALL_SPORTS.length * 3 && created < TARGET_SIGNALS) {
        log("WARN", `Exhausted ${sportIdx} sport scans, only created ${created}/${TARGET_SIGNALS}`);
        break;
      }
    }

    // ── Report ──────────────────────────────────────────────────────────────

    log("INFO", "\n========================================");
    log("INFO", "       20-SIGNAL BENCHMARK RESULTS");
    log("INFO", "========================================");
    log("INFO", `Created: ${created}/${TARGET_SIGNALS}`);
    log("INFO", `Purchased: ${purchased}/${created}`);

    const successCreates = timings.filter((t) => t.signalId);
    const successPurchases = timings.filter((t) => t.purchaseSuccess);

    if (successCreates.length > 0) {
      const ct = successCreates.map((t) => t.createMs);
      log("INFO", `\nSignal Creation (${successCreates.length} successful):`);
      log("INFO", `  Min:  ${(Math.min(...ct) / 1000).toFixed(1)}s`);
      log("INFO", `  Max:  ${(Math.max(...ct) / 1000).toFixed(1)}s`);
      log("INFO", `  Avg:  ${(ct.reduce((a, b) => a + b, 0) / ct.length / 1000).toFixed(1)}s`);
    }

    if (successPurchases.length > 0) {
      const pt = successPurchases.map((t) => t.purchaseMs);
      log("INFO", `\nSignal Purchase (${successPurchases.length} successful):`);
      log("INFO", `  Min:  ${(Math.min(...pt) / 1000).toFixed(1)}s`);
      log("INFO", `  Max:  ${(Math.max(...pt) / 1000).toFixed(1)}s`);
      log("INFO", `  Avg:  ${(pt.reduce((a, b) => a + b, 0) / pt.length / 1000).toFixed(1)}s`);
    }

    // Combined end-to-end timing (create + purchase)
    if (successPurchases.length > 0) {
      const e2e = successPurchases.map((t) => t.createMs + t.purchaseMs);
      log("INFO", `\nEnd-to-End (create + purchase, ${successPurchases.length}):`);
      log("INFO", `  Min:  ${(Math.min(...e2e) / 1000).toFixed(1)}s`);
      log("INFO", `  Max:  ${(Math.max(...e2e) / 1000).toFixed(1)}s`);
      log("INFO", `  Avg:  ${(e2e.reduce((a, b) => a + b, 0) / e2e.length / 1000).toFixed(1)}s`);
    }

    // Write TSV
    const header = "idx\tsport\tgame\tcreate_s\tsignal_id\tpurchase_s\tpurchase_ok\terror\n";
    const rows = timings.map((t) =>
      `${t.idx}\t${t.sport}\t${t.game}\t${(t.createMs / 1000).toFixed(1)}\t${t.signalId || ""}\t${(t.purchaseMs / 1000).toFixed(1)}\t${t.purchaseSuccess}\t${t.error || ""}`
    ).join("\n");
    writeFileSync(RESULTS_FILE, header + rows + "\n");
    log("INFO", `\nDetailed results: ${RESULTS_FILE}`);

    // Per-signal detail
    log("INFO", "\n--- Per-Signal Detail ---");
    for (const t of timings) {
      const status = t.purchaseSuccess ? "OK" : "FAIL";
      log("INFO", `  #${t.idx} ${t.sport} "${t.game}" create=${(t.createMs / 1000).toFixed(1)}s purchase=${(t.purchaseMs / 1000).toFixed(1)}s [${status}]${t.error ? ` (${t.error})` : ""}`);
    }

    expect(created).toBeGreaterThan(0);
    log("INFO", "\n=== Benchmark Complete ===");
  });
});
