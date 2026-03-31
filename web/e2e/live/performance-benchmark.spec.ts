import { test as base, expect, type Page } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createHash } from "crypto";

/**
 * Performance benchmark for signal creation and purchase.
 *
 * Adapts selectors from signal-stress-loop.spec.ts which is proven to work.
 *
 * Usage:
 *   npx playwright test --config=playwright.live.config.ts performance-benchmark
 */

// E2E_TEST_PRIVATE_KEY must be set in .env (Base Sepolia test wallet, no real funds)
const E2E_KEY = (process.env.E2E_TEST_PRIVATE_KEY ?? "") as `0x${string}`;
if (!E2E_KEY) throw new Error("E2E_TEST_PRIVATE_KEY not set in .env");

const account = privateKeyToAccount(E2E_KEY);

const N_CREATE = parseInt(process.env.BENCH_CREATE || "10", 10);
const N_PURCHASE = parseInt(process.env.BENCH_PURCHASE || "5", 10);

// ── Fixtures ───────────────────────────────────────────────────────────────

const test = base.extend<{ wp: Page }>({
  wp: async ({ page }, use) => {
    await installMockWallet({
      page,
      account,
      defaultChain: baseSepolia,
    });
    await use(page);
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function connectWallet(page: Page) {
  const connectBtn = page.getByRole("button", { name: /get started/i });
  try {
    await connectBtn.waitFor({ state: "visible", timeout: 10_000 });
  } catch { return; }
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

async function injectMasterSeed(page: Page) {
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

interface Timing {
  i: number;
  totalMs: number;
  steps: Record<string, number>;
  signalId?: string;
  err?: string;
}

function report(label: string, data: Timing[]) {
  const ok = data.filter((d) => !d.err);
  const fail = data.filter((d) => !!d.err);
  const t = ok.map((d) => d.totalMs / 1000);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${label}  (${ok.length} ok, ${fail.length} failed / ${data.length})`);
  console.log("=".repeat(60));

  if (t.length > 0) {
    const min = Math.min(...t);
    const max = Math.max(...t);
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    const sd = Math.sqrt(t.reduce((s, v) => s + (v - mean) ** 2, 0) / t.length);
    console.log(`  Min:  ${min.toFixed(1)}s`);
    console.log(`  Mean: ${mean.toFixed(1)}s`);
    console.log(`  SD:   ${sd.toFixed(1)}s`);
    console.log(`  Max:  ${max.toFixed(1)}s`);
    console.log(`  All:  [${t.map((v) => v.toFixed(1) + "s").join(", ")}]`);

    const stepKeys = Object.keys(ok[0].steps);
    console.log("\n  Step breakdown (mean):");
    for (const k of stepKeys) {
      const vals = ok.map((d) => (d.steps[k] ?? 0) / 1000);
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      console.log(`    ${k.padEnd(30)} ${m.toFixed(1)}s`);
    }
  }
  if (fail.length > 0) {
    console.log("\n  Failures:");
    for (const f of fail) console.log(`    #${f.i}: ${f.err}`);
  }
}

// ── Creation ───────────────────────────────────────────────────────────────

test.describe("Creation benchmark", () => {
  test.setTimeout(900_000);

  test(`create ${N_CREATE} signals`, async ({ wp: page }) => {
    const results: Timing[] = [];
    const ids: string[] = [];

    for (let i = 0; i < N_CREATE; i++) {
      const steps: Record<string, number> = {};
      const t0 = Date.now();
      let ts = t0;
      let err: string | undefined;
      let signalId: string | undefined;

      try {
        // 1. Navigate + inject seed + connect wallet
        await page.goto("/genius/signal/new");
        await injectMasterSeed(page);
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await connectWallet(page);
        await page.waitForTimeout(3000);
        steps["01_navigate"] = Date.now() - ts; ts = Date.now();

        // 2. Pick sport (use getByRole like the stress test)
        const sportBtn = page.getByRole("button", { name: /^NBA$/i });
        await sportBtn.waitFor({ state: "visible", timeout: 10_000 });
        await sportBtn.click();
        await page.waitForTimeout(5000);
        steps["02_pick_sport"] = Date.now() - ts; ts = Date.now();

        // 3. Find games (h3 with @ separator)
        const gameHeadings = page.locator("h3").filter({ hasText: /@/ });
        const gCount = await gameHeadings.count();
        if (gCount === 0) throw new Error("No games available");
        steps["03_load_games"] = Date.now() - ts; ts = Date.now();

        // 4. Click a game
        const gIdx = i % gCount;
        const h3 = gameHeadings.nth(gIdx);
        await h3.scrollIntoViewIfNeeded();
        await h3.click();
        await page.waitForTimeout(2000);
        steps["04_select_game"] = Date.now() - ts; ts = Date.now();

        // 5. Pick moneyline bet
        const cardContainer = page.locator(".card").filter({ has: h3 });
        const mlSection = (await cardContainer.count() > 0 ? cardContainer.first() : page)
          .locator("text=Moneyline")
          .locator("xpath=ancestor::div[1]");
        const mlBtns = mlSection.locator("button");
        const mlCount = await mlBtns.count().catch(() => 0);
        if (mlCount === 0) throw new Error("No moneyline bets available");
        await mlBtns.first().scrollIntoViewIfNeeded();
        await mlBtns.first().click();
        await page.waitForTimeout(2000);
        steps["05_pick_bet"] = Date.now() - ts; ts = Date.now();

        // 6. Review step
        await page.getByText("Review Lines").waitFor({ state: "visible", timeout: 10_000 });
        const nextBtn = page.getByRole("button", { name: /next.*configure|continue/i });
        if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await nextBtn.click();
          await page.waitForTimeout(1000);
        }
        steps["06_review"] = Date.now() - ts; ts = Date.now();

        // 7. Configure step
        await page.getByText("Configure Signal").waitFor({ state: "visible", timeout: 10_000 });
        steps["07_configure"] = Date.now() - ts; ts = Date.now();

        // 8. Submit
        const submitBtn = page.getByRole("button", { name: /create signal/i });
        await submitBtn.waitFor({ state: "visible", timeout: 10_000 });

        // If button says "Set Up Encryption" instead, seed was lost
        const btnText = await submitBtn.textContent();
        if (btnText?.toLowerCase().includes("encryption")) {
          throw new Error("Master seed lost, need re-injection");
        }

        await submitBtn.scrollIntoViewIfNeeded();
        await submitBtn.click({ force: true });

        // 9. Wait for result
        for (let s = 0; s < 120; s++) {
          await page.waitForTimeout(1000);

          const success = await page
            .getByText(/Signal Created|Signal Committed|Shares Distributed/i)
            .first().isVisible().catch(() => false);
          if (success) {
            const idEl = page.locator("[data-signal-id]");
            signalId = await idEl.getAttribute("data-signal-id").catch(() => null) ?? undefined;
            if (!signalId) {
              const m = page.url().match(/\/signal\/(\d+)/);
              signalId = m?.[1];
            }
            break;
          }

          // Check for redirect to genius dashboard (means success)
          if (page.url().includes("/genius") && !page.url().includes("/signal/new")) {
            const m = page.url().match(/\/signal\/(\d+)/);
            signalId = m?.[1];
            break;
          }

          // Check for error
          const errEl = page.locator(".bg-red-50 .text-red-600").first();
          if (await errEl.isVisible().catch(() => false)) {
            const msg = await errEl.textContent().catch(() => "unknown");
            throw new Error(`Creation error: ${msg?.slice(0, 100)}`);
          }

          if (s === 119) throw new Error("Timed out (120s)");
        }

        steps["08_commit_shares"] = Date.now() - ts;
        if (signalId) ids.push(signalId);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }

      results.push({ i: i + 1, totalMs: Date.now() - t0, steps, signalId, err });
      console.log(`  Create #${i + 1}: ${err ? "FAIL (" + err.slice(0, 80) + ")" : (Date.now() - t0) / 1000 + "s"}`);
      if (i < N_CREATE - 1) await page.waitForTimeout(3000);
    }

    report("SIGNAL CREATION", results);
    if (ids.length) console.log(`\nCreated IDs: ${ids.join(", ")}`);
    expect(results.some((r) => !r.err)).toBeTruthy();
  });
});

// ── Purchase ───────────────────────────────────────────────────────────────

test.describe("Purchase benchmark", () => {
  test.setTimeout(900_000);

  test(`purchase up to ${N_PURCHASE} signals`, async ({ wp: page }) => {
    const results: Timing[] = [];

    // Discover signals: check env var first, then browse page
    const envIds = process.env.SIGNAL_IDS?.split(",").filter(Boolean) ?? [];
    let signals: { signal_id: string }[] = envIds.map((id) => ({ signal_id: id.trim() }));

    if (signals.length === 0) {
      // Navigate the browse page to find signals
      await page.goto("/idiot/browse");
      await connectWallet(page);
      // Wait longer for cold start: API scans events on first call
      for (let waitSec = 0; waitSec < 60; waitSec += 5) {
        await page.waitForTimeout(5_000);
        const linkCount = await page.locator("a[href*='/idiot/signal/']").count();
        if (linkCount > 0) break;
      }
      const signalLinks = page.locator("a[href*='/idiot/signal/']");
      const linkCount = await signalLinks.count();
      console.log(`Found ${linkCount} signal links on browse page`);
      for (let j = 0; j < linkCount; j++) {
        const href = await signalLinks.nth(j).getAttribute("href");
        const m = href?.match(/\/idiot\/signal\/(\d+)/);
        if (m) signals.push({ signal_id: m[1] });
      }
    } else {
      console.log(`Using ${signals.length} signal IDs from SIGNAL_IDS env`);
    }

    if (signals.length === 0) { console.log("SKIP: no signals found"); return; }

    const n = Math.min(N_PURCHASE, signals.length);

    for (let i = 0; i < n; i++) {
      const sig = signals[i];
      const steps: Record<string, number> = {};
      const t0 = Date.now();
      let ts = t0;
      let err: string | undefined;

      try {
        // 1. Navigate + connect
        await page.goto(`/idiot/signal/${sig.signal_id}`);
        await page.waitForLoadState("domcontentloaded");
        await connectWallet(page);
        await page.waitForTimeout(5000);
        steps["01_navigate"] = Date.now() - ts; ts = Date.now();

        // 2. Check page state
        const isConnect = await page.getByText(/connect your wallet/i).isVisible().catch(() => false);
        if (isConnect) throw new Error("Wallet not connected after connectWallet()");
        const isNotFound = await page.getByText(/not found/i).isVisible().catch(() => false);
        if (isNotFound) throw new Error("Signal not found");
        steps["02_page_load"] = Date.now() - ts; ts = Date.now();

        // 2b. Dismiss Terms of Service modal if present
        const tosCheckbox = page.locator("input[type='checkbox']").first();
        if (await tosCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
          await tosCheckbox.check();
          const acceptBtn = page.getByRole("button", { name: /accept.*continue|accept/i }).first();
          if (await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await acceptBtn.click();
            await page.waitForTimeout(1000);
          }
        }

        // 3. Fill notional (use #notional ID selector)
        const inp = page.locator("#notional");
        if (!await inp.isVisible({ timeout: 5000 }).catch(() => false)) {
          await page.screenshot({ path: `test-results/purchase-noinput-${i}.png`, fullPage: true });
          throw new Error("Notional input not visible");
        }
        await inp.fill("10");
        // Verify the value was set
        const val = await inp.inputValue();
        if (!val || val === "0") {
          await inp.clear();
          await inp.type("10");
        }
        steps["03_fill_notional"] = Date.now() - ts; ts = Date.now();

        // Capture console logs from the purchase flow
        const purchaseLogs: string[] = [];
        page.on("console", (msg) => {
          const text = msg.text();
          if (text.includes("[purchase]") || text.includes("error") || text.includes("FAIL")) {
            purchaseLogs.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text.slice(0, 200)}`);
          }
        });

        // 4. Click purchase
        const buyBtn = page.getByRole("button", { name: /purchase signal/i }).first();
        if (!await buyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          // Take a screenshot to see what the page looks like
          await page.screenshot({ path: `test-results/purchase-nobutton-${i}.png`, fullPage: true });
          throw new Error("Purchase button not visible");
        }
        await buyBtn.click();

        // 5. Wait for result (check every 10s, take screenshots for debugging)
        let outcome = "timeout";
        for (let sec = 0; sec < 180; sec += 5) {
          await page.waitForTimeout(5_000);

          // Check for success
          if (await page.getByText(/Signal Purchased|Decrypted|Your Pick/i).first().isVisible().catch(() => false)) {
            outcome = "ok";
            break;
          }

          // Check for error: the purchase page shows errors in role="alert" divs
          const alertEl = page.locator("[role='alert']").first();
          if (await alertEl.isVisible().catch(() => false)) {
            const alertText = await alertEl.textContent().catch(() => "");
            if (alertText && alertText.length > 10) {
              throw new Error(`Purchase error: ${alertText.slice(0, 150)}`);
            }
          }
          // Also check for red error text outside alerts
          const redErr = page.locator(".bg-red-50 .text-red-600").first();
          if (await redErr.isVisible().catch(() => false)) {
            const errText = await redErr.textContent().catch(() => "");
            if (errText && errText.length > 5) {
              throw new Error(`Purchase error: ${errText.slice(0, 150)}`);
            }
          }

          // Log progress every 30s
          if (sec > 0 && sec % 30 === 0) {
            await page.screenshot({ path: `test-results/purchase-progress-${i}-${sec}s.png`, fullPage: true });
            console.log(`    [${sec}s] Still waiting. Console: ${purchaseLogs.slice(-3).join(" | ")}`);
          }
        }

        steps["04_purchase"] = Date.now() - ts;

        if (outcome === "timeout") throw new Error("Timed out (180s)");
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }

      results.push({ i: i + 1, totalMs: Date.now() - t0, steps, err });
      console.log(`  Purchase #${i + 1}: ${err ? "FAIL (" + err.slice(0, 80) + ")" : (Date.now() - t0) / 1000 + "s"}`);
      if (i < n - 1) await page.waitForTimeout(2000);
    }

    report("SIGNAL PURCHASE", results);
  });
});
