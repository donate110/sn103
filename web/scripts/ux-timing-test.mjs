#!/usr/bin/env node
/**
 * UX Timing Test: measures real user-facing latency for signal creation and purchase.
 * Creates N signals, attempts N purchases, logs timing for every step.
 *
 * Usage: node scripts/ux-timing-test.mjs [--signals N] [--purchases N]
 */

import { ethers } from "ethers";
import crypto from "crypto";

// ─── Config ───────────────────────────────────────────────────────────
const RPC_URL = "https://sepolia.base.org";
const BASE_URL = process.env.LIVE_URL ?? "https://djinn.gg";

const ADDRESSES = {
  signalCommitment: "0x4712479Ba57c9ED40405607b2B18967B359209C0",
  escrow: "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
  collateral: "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88",
  account: "0x4546354Dd32a613B76Abf530F81c8359e7cE440B",
  usdc: "0x00e8293b05dbD3732EF3396ad1483E87e7265054",
};

const PRIVATE_KEY = process.env.E2E_TEST_PRIVATE_KEY || process.env.E2E_GENIUS_KEY || "";
if (!PRIVATE_KEY) {
  console.error("Set E2E_TEST_PRIVATE_KEY or E2E_GENIUS_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const NUM_SIGNALS = parseInt(args.find((a, i) => args[i - 1] === "--signals") || "5");
const NUM_PURCHASES = parseInt(args.find((a, i) => args[i - 1] === "--purchases") || "5");

// ─── ABIs ─────────────────────────────────────────────────────────────
const SIGNAL_ABI = [
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks)) external",
  "function isActive(uint256 signalId) view returns (bool)",
];
const ESCROW_ABI = [
  "function deposit(uint256 amount) external",
  "function getBalance(address) view returns (uint256)",
  "function purchase(uint256 signalId, uint256 notional, uint256 odds) external",
];
const COLLATERAL_ABI = [
  "function deposit(uint256 amount) external",
  "function getAvailable(address) view returns (uint256)",
];
const USDC_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ─── Helpers ──────────────────────────────────────────────────────────
function timer() {
  const start = Date.now();
  return () => Date.now() - start;
}

function randomSignalId() {
  return BigInt("0x" + crypto.randomBytes(32).toString("hex"));
}

function randomBlob() {
  const iv = crypto.randomBytes(12).toString("hex");
  const ct = crypto.randomBytes(64).toString("hex");
  return "0x" + Buffer.from(`${iv}:${ct}`).toString("hex");
}

function randomDecoyLines() {
  const sports = ["NBA", "NFL", "MLB", "NHL"];
  const teams = ["Lakers", "Celtics", "Warriors", "Bulls", "Nets", "Heat", "Bucks", "Sixers", "Suns", "Nuggets"];
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const sport = sports[Math.floor(Math.random() * sports.length)];
    const t1 = teams[Math.floor(Math.random() * teams.length)];
    const t2 = teams[Math.floor(Math.random() * teams.length)];
    const spread = (Math.random() * 10 - 5).toFixed(1);
    lines.push(`${sport}|${t1} vs ${t2}|spreads|${spread}|${t1}`);
  }
  return lines;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`App: ${BASE_URL}`);
  console.log(`Signals to create: ${NUM_SIGNALS}`);
  console.log(`Purchases to attempt: ${NUM_PURCHASES}`);
  console.log();

  // Check wallet balance
  const ethBal = await provider.getBalance(wallet.address);
  console.log(`ETH balance: ${ethers.formatEther(ethBal)}`);
  if (ethBal < ethers.parseEther("0.0002")) {
    console.error("Insufficient ETH. Need at least 0.0002 for gas.");
    process.exit(1);
  }

  const usdc = new ethers.Contract(ADDRESSES.usdc, USDC_ABI, wallet);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log(`USDC balance: ${ethers.formatUnits(usdcBal, 6)}`);

  const signal = new ethers.Contract(ADDRESSES.signalCommitment, SIGNAL_ABI, wallet);
  const escrow = new ethers.Contract(ADDRESSES.escrow, ESCROW_ABI, wallet);
  const collateral = new ethers.Contract(ADDRESSES.collateral, COLLATERAL_ABI, wallet);

  // ─── Step 0: Ensure funds ────────────────────────────
  const t0 = timer();
  console.log("\n=== STEP 0: Fund wallet ===");

  // Check existing balances before doing any setup txs
  const availColl = await collateral.getAvailable(wallet.address);
  const escrowBal = await escrow.getBalance(wallet.address);
  console.log(`  Collateral available: ${ethers.formatUnits(availColl, 6)} USDC`);
  console.log(`  Escrow balance: ${ethers.formatUnits(escrowBal, 6)} USDC`);

  const needsSetup = usdcBal < ethers.parseUnits("1000", 6) ||
    availColl < ethers.parseUnits("500", 6) ||
    escrowBal < ethers.parseUnits("200", 6);

  if (needsSetup) {
    console.log("  Running setup transactions...");
    try {
      if (usdcBal < ethers.parseUnits("1000", 6)) {
        const mintTx = await usdc.mint(wallet.address, ethers.parseUnits("10000", 6));
        await mintTx.wait();
        console.log(`  Minted 10000 USDC`);
      }
      if (availColl < ethers.parseUnits("500", 6)) {
        const appTx = await usdc.approve(ADDRESSES.collateral, ethers.MaxUint256);
        await appTx.wait();
        const depTx = await collateral.deposit(ethers.parseUnits("2000", 6));
        await depTx.wait();
        console.log(`  Deposited 2000 collateral`);
      }
      if (escrowBal < ethers.parseUnits("200", 6)) {
        const appTx = await usdc.approve(ADDRESSES.escrow, ethers.MaxUint256);
        await appTx.wait();
        const depTx = await escrow.deposit(ethers.parseUnits("1000", 6));
        await depTx.wait();
        console.log(`  Deposited 1000 escrow`);
      }
    } catch (err) {
      console.log(`  Setup tx failed (may already be done): ${err.message?.slice(0, 80)}`);
    }
  } else {
    console.log("  Sufficient funds, skipping setup.");
  }
  console.log(`  Setup total: ${t0()}ms`);

  // ─── Step 1: Create signals ──────────────────────────
  console.log(`\n=== STEP 1: Create ${NUM_SIGNALS} signals ===`);
  const createdSignals = [];
  const createTimings = [];

  for (let i = 0; i < NUM_SIGNALS; i++) {
    const signalId = randomSignalId();
    const blob = randomBlob();
    const commitHash = ethers.keccak256(ethers.toUtf8Bytes(blob));
    const decoyLines = randomDecoyLines();
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 6 * 3600); // 6h from now

    const params = {
      signalId,
      encryptedBlob: blob,
      commitHash,
      sport: "basketball_nba",
      maxPriceBps: 1000n, // 10% fee
      slaMultiplierBps: 10000n, // 100% SLA
      maxNotional: ethers.parseUnits("100", 6),
      minNotional: 0n,
      expiresAt,
      decoyLines,
      availableSportsbooks: [],
    };

    const t = timer();
    try {
      const tx = await signal.commit(params);
      const sendMs = t();
      const receipt = await tx.wait();
      const confirmMs = t();

      createdSignals.push(signalId.toString());
      createTimings.push({ i: i + 1, sendMs, confirmMs, status: "ok", gas: Number(receipt.gasUsed) });
      console.log(`  Signal ${i + 1}/${NUM_SIGNALS}: send=${sendMs}ms confirm=${confirmMs}ms gas=${receipt.gasUsed}`);
    } catch (err) {
      const elapsed = t();
      createTimings.push({ i: i + 1, sendMs: elapsed, confirmMs: elapsed, status: "error", error: err.message?.slice(0, 100) });
      console.log(`  Signal ${i + 1}/${NUM_SIGNALS}: FAILED at ${elapsed}ms: ${err.message?.slice(0, 100)}`);
    }

    // Brief nonce delay between signals
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ─── Step 2: Check line availability via API ─────────
  console.log(`\n=== STEP 2: Line check via API (${createdSignals.length} signals) ===`);
  const lineCheckTimings = [];

  for (let i = 0; i < Math.min(createdSignals.length, NUM_PURCHASES); i++) {
    const t = timer();
    try {
      const res = await fetchWithTimeout(`${BASE_URL}/api/miner/v1/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: randomDecoyLines().slice(0, 10).map((line, idx) => {
            const parts = line.split("|");
            return {
              index: idx + 1,
              sport: "basketball_nba",
              event_id: `test-${Date.now()}`,
              home_team: parts[1]?.split(" vs ")[0] || "Home",
              away_team: parts[1]?.split(" vs ")[1] || "Away",
              market: "spreads",
              line: parseFloat(parts[3] || "0"),
              side: parts[4] || "Home",
            };
          }),
        }),
      });
      const elapsed = t();
      const body = await res.json().catch(() => ({}));
      const available = body.available_indices?.length ?? 0;
      lineCheckTimings.push({ i: i + 1, ms: elapsed, status: res.status, available });
      console.log(`  Check ${i + 1}: ${elapsed}ms status=${res.status} available=${available}`);
    } catch (err) {
      const elapsed = t();
      lineCheckTimings.push({ i: i + 1, ms: elapsed, status: "error", error: err.message?.slice(0, 80) });
      console.log(`  Check ${i + 1}: FAILED at ${elapsed}ms: ${err.message?.slice(0, 80)}`);
    }
  }

  // ─── Step 3: Validator discovery ─────────────────────
  console.log("\n=== STEP 3: Validator discovery ===");
  const tDisc = timer();
  let validators = [];
  try {
    const res = await fetchWithTimeout(`${BASE_URL}/api/validators/discover`);
    const body = await res.json();
    validators = body.validators || (Array.isArray(body) ? body : []);
    console.log(`  Discovery: ${tDisc()}ms, found ${validators.length} validators`);
    for (const v of validators.slice(0, 5)) {
      console.log(`    UID ${v.uid}: ${v.ip}:${v.port} stake=${v.stake?.toFixed?.(2) ?? "?"}`);
    }
  } catch (err) {
    console.log(`  Discovery FAILED: ${tDisc()}ms ${err.message?.slice(0, 80)}`);
  }

  // ─── Step 4: Validator health checks ─────────────────
  console.log("\n=== STEP 4: Validator health checks ===");
  const healthTimings = [];
  for (const v of validators.slice(0, 10)) {
    const t = timer();
    try {
      const res = await fetchWithTimeout(`${BASE_URL}/api/validators/${v.uid}/health`, {}, 10000);
      const elapsed = t();
      const body = await res.json().catch(() => ({}));
      healthTimings.push({ uid: v.uid, ms: elapsed, status: body.status || res.status, version: body.version });
      console.log(`  UID ${v.uid}: ${elapsed}ms status=${body.status || res.status} v=${body.version || "?"}`);
    } catch (err) {
      const elapsed = t();
      healthTimings.push({ uid: v.uid, ms: elapsed, status: "error" });
      console.log(`  UID ${v.uid}: FAILED ${elapsed}ms`);
    }
  }

  // ─── Step 5: Purchase attempts ───────────────────────
  console.log(`\n=== STEP 5: Purchase ${NUM_PURCHASES} signals (on-chain only, no MPC) ===`);
  const purchaseTimings = [];

  // Purchase using the same wallet (it already has escrow balance)
  console.log(`  Buying with: ${wallet.address} (escrow: ${ethers.formatUnits(escrowBal, 6)} USDC)`);

  for (let i = 0; i < Math.min(createdSignals.length, NUM_PURCHASES); i++) {
    const sigId = BigInt(createdSignals[i]);
    const notional = ethers.parseUnits("10", 6); // $10
    const odds = ethers.parseUnits("1.91", 6); // -110

    const t = timer();
    try {
      const tx = await escrow.purchase(sigId, notional, odds);
      const sendMs = t();
      const receipt = await tx.wait();
      const confirmMs = t();
      purchaseTimings.push({ i: i + 1, sendMs, confirmMs, status: "ok", gas: Number(receipt.gasUsed) });
      console.log(`  Purchase ${i + 1}/${NUM_PURCHASES}: send=${sendMs}ms confirm=${confirmMs}ms gas=${receipt.gasUsed}`);
    } catch (err) {
      const elapsed = t();
      const msg = err.message?.slice(0, 120) || "unknown";
      purchaseTimings.push({ i: i + 1, sendMs: elapsed, confirmMs: elapsed, status: "error", error: msg });
      console.log(`  Purchase ${i + 1}/${NUM_PURCHASES}: FAILED at ${elapsed}ms: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ─── Step 6: Browse API timing ───────────────────────
  console.log("\n=== STEP 6: API response times ===");
  const apiTimings = [];
  const endpoints = [
    { name: "health", url: `${BASE_URL}/api/health` },
    { name: "browse", url: `${BASE_URL}/api/idiot/browse?limit=20` },
    { name: "odds", url: `${BASE_URL}/api/odds?sport=basketball_nba` },
    { name: "network", url: `${BASE_URL}/api/network/status` },
    { name: "discover", url: `${BASE_URL}/api/validators/discover` },
  ];
  for (const ep of endpoints) {
    const t = timer();
    try {
      const res = await fetchWithTimeout(ep.url, {}, 30000);
      const elapsed = t();
      const size = (await res.text()).length;
      apiTimings.push({ name: ep.name, ms: elapsed, status: res.status, sizeKb: (size / 1024).toFixed(1) });
      console.log(`  ${ep.name}: ${elapsed}ms status=${res.status} size=${(size / 1024).toFixed(1)}KB`);
    } catch (err) {
      const elapsed = t();
      apiTimings.push({ name: ep.name, ms: elapsed, status: "error" });
      console.log(`  ${ep.name}: FAILED ${elapsed}ms`);
    }
  }

  // ─── Summary ─────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const avgCreate = createTimings.filter((t) => t.status === "ok");
  const avgPurchase = purchaseTimings.filter((t) => t.status === "ok");

  console.log(`\nSignal Creation (${NUM_SIGNALS} attempted, ${avgCreate.length} succeeded):`);
  if (avgCreate.length > 0) {
    const avgSend = Math.round(avgCreate.reduce((s, t) => s + t.sendMs, 0) / avgCreate.length);
    const avgConfirm = Math.round(avgCreate.reduce((s, t) => s + t.confirmMs, 0) / avgCreate.length);
    const avgGas = Math.round(avgCreate.reduce((s, t) => s + t.gas, 0) / avgCreate.length);
    console.log(`  Avg send: ${avgSend}ms`);
    console.log(`  Avg confirm: ${avgConfirm}ms`);
    console.log(`  Avg gas: ${avgGas}`);
  }
  const failedCreate = createTimings.filter((t) => t.status !== "ok");
  if (failedCreate.length > 0) {
    console.log(`  FAILURES (${failedCreate.length}):`);
    for (const f of failedCreate) console.log(`    #${f.i}: ${f.error}`);
  }

  console.log(`\nPurchase (${NUM_PURCHASES} attempted, ${avgPurchase.length} succeeded):`);
  if (avgPurchase.length > 0) {
    const avgSend = Math.round(avgPurchase.reduce((s, t) => s + t.sendMs, 0) / avgPurchase.length);
    const avgConfirm = Math.round(avgPurchase.reduce((s, t) => s + t.confirmMs, 0) / avgPurchase.length);
    const avgGas = Math.round(avgPurchase.reduce((s, t) => s + t.gas, 0) / avgPurchase.length);
    console.log(`  Avg send: ${avgSend}ms`);
    console.log(`  Avg confirm: ${avgConfirm}ms`);
    console.log(`  Avg gas: ${avgGas}`);
  }
  const failedPurchase = purchaseTimings.filter((t) => t.status !== "ok");
  if (failedPurchase.length > 0) {
    console.log(`  FAILURES (${failedPurchase.length}):`);
    for (const f of failedPurchase) console.log(`    #${f.i}: ${f.error}`);
  }

  console.log(`\nLine Checks (${lineCheckTimings.length}):`);
  if (lineCheckTimings.length > 0) {
    const avg = Math.round(lineCheckTimings.reduce((s, t) => s + t.ms, 0) / lineCheckTimings.length);
    const okCount = lineCheckTimings.filter((t) => t.status === 200).length;
    console.log(`  Avg: ${avg}ms`);
    console.log(`  Success: ${okCount}/${lineCheckTimings.length}`);
  }

  console.log(`\nValidator Health (${healthTimings.length}):`);
  const healthyV = healthTimings.filter((t) => t.status === "ok");
  console.log(`  Healthy: ${healthyV.length}/${healthTimings.length}`);
  if (healthyV.length > 0) {
    const avg = Math.round(healthyV.reduce((s, t) => s + t.ms, 0) / healthyV.length);
    console.log(`  Avg response: ${avg}ms`);
  }

  console.log(`\nAPI Response Times:`);
  for (const t of apiTimings) {
    console.log(`  ${t.name}: ${t.ms}ms (${t.sizeKb}KB)`);
  }

  console.log("\n" + "=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
