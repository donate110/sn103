#!/usr/bin/env node
/**
 * Djinn Signal Stress Test
 * Creates 20 signals on-chain and distributes Shamir shares,
 * then attempts to purchase each one.
 * Reports timing and success rates.
 *
 * Usage:
 *   source web/.env && node scripts/signal-stress-test.mjs [--count=20] [--skip-purchase] [--base-url=https://www.djinn.gg]
 *
 * Required env vars (in web/.env):
 *   E2E_TEST_PRIVATE_KEY or E2E_GENIUS_KEY - Genius wallet private key
 *   E2E_DEPLOYER_KEY - Deployer wallet private key (funds idiot wallets)
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { writeFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(path.join(__dirname, "../web/package.json"));

const ethersModule = await import(require.resolve("ethers"));
const ethers = ethersModule;

const { encryptSignal, toHex } = await import(
  path.join(__dirname, "../sdk/dist/index.mjs")
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const countFlag = args.find((a) => a.startsWith("--count="));
const TARGET = countFlag ? parseInt(countFlag.split("=")[1]) : 20;
const SKIP_PURCHASE = args.includes("--skip-purchase");
const baseUrlFlag = args.find((a) => a.startsWith("--base-url="));
const BASE_URL = baseUrlFlag ? baseUrlFlag.split("=")[1] : "https://www.djinn.gg";

const GENIUS_PRIVATE_KEY = process.env.E2E_TEST_PRIVATE_KEY || process.env.E2E_GENIUS_KEY;
const DEPLOYER_PRIVATE_KEY = process.env.E2E_DEPLOYER_KEY;
const RPC_URL = "https://sepolia.base.org";
const CHAIN_ID = 84532;
// Cycle limit per genius-idiot pair (Account contract limits to 10)
const CYCLE_LIMIT = 8;

const CONTRACTS = {
  signalCommitment: "0x4712479Ba57c9ED40405607b2B18967B359209C0",
  escrow: "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
  collateral: "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88",
  usdc: "0x00e8293b05dbD3732EF3396ad1483E87e7265054",
};

const SIGNAL_COMMITMENT_ABI = [
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks) p) external",
  "function getSignal(uint256 signalId) external view returns (tuple(address genius, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, uint8 status, uint256 createdAt))",
  "function isActive(uint256 signalId) external view returns (bool)",
];

const ESCROW_ABI = [
  "function deposit(uint256 amount) external",
  "function purchase(uint256 signalId, uint256 notional, uint256 odds) external returns (uint256 purchaseId)",
  "function getBalance(address user) external view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function mint(address to, uint256 amount) external",
];

const COLLATERAL_ABI = [
  "function deposit(uint256 amount) external",
  "function getDeposit(address genius) external view returns (uint256)",
  "function getAvailable(address genius) external view returns (uint256)",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts() { return new Date().toISOString().slice(11, 19); }
function log(level, msg) { console.log(`[${ts()}] [${level}] ${msg}`); }

async function api(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json", ...opts.headers },
        signal: AbortSignal.timeout(opts.timeout || 30_000),
        ...opts,
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { _raw: text }; }
      return { status: res.status, ok: res.ok, json };
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function authenticate(wallet) {
  const address = wallet.address;
  const { json: c } = await api("/api/auth/connect", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  if (!c.nonce) throw new Error(`Auth connect failed: ${JSON.stringify(c)}`);
  const sig = await wallet.signMessage(c.challenge);
  const { json: v } = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature: sig, nonce: c.nonce }),
  });
  if (!v.session_token) throw new Error(`Auth verify failed: ${JSON.stringify(v)}`);
  return v.session_token;
}

function createProvider() {
  const fetchReq = new ethers.FetchRequest(RPC_URL);
  fetchReq.timeout = 60_000;
  return new ethers.JsonRpcProvider(fetchReq, CHAIN_ID, {
    staticNetwork: ethers.Network.from(CHAIN_ID),
    batchMaxCount: 1,
    pollingInterval: 4000,
  });
}

async function retry(fn, maxAttempts = 3, label = "") {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      log("WARN", `  Retry ${i + 1}/${maxAttempts}${label ? " for " + label : ""}: ${err.message?.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Signal creation
// ---------------------------------------------------------------------------

async function createOneSignal(idx, wallet, provider, networkConfig, oddsData, authHeaders) {
  const start = Date.now();
  const result = { idx, sport: "baseball_mlb", game: "", createMs: 0, signalId: null, error: null };

  try {
    // Pick a game (cycle through available games)
    const game = oddsData[idx % oddsData.length];
    result.game = `${game.away_team} @ ${game.home_team}`;

    const bookmaker = game.bookmakers[0];
    const spreadMarket = bookmaker.markets.find((m) => m.key === "spreads");
    const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");

    const realPick = {
      sport: "baseball_mlb",
      event_id: game.id,
      home_team: game.home_team,
      away_team: game.away_team,
      market: spreadMarket ? "spreads" : "h2h",
      side: spreadMarket?.outcomes[0]?.name || h2hMarket?.outcomes[0]?.name || game.home_team,
      line: spreadMarket?.outcomes[0]?.point || null,
      price: spreadMarket?.outcomes[0]?.price || h2hMarket?.outcomes[0]?.price || 1.91,
      commence_time: game.commence_time,
    };

    // Generate decoys from real odds
    const decoys = [];
    const markets = ["spreads", "totals", "h2h"];
    for (let i = 0; i < 9; i++) {
      const g = oddsData[(idx + i + 1) % oddsData.length];
      const bk = g.bookmakers[0];
      const mkt = markets[i % 3];
      const market = bk?.markets?.find((m) => m.key === mkt);
      const outcome = market?.outcomes?.[i % 2] || market?.outcomes?.[0];
      decoys.push({
        sport: "baseball_mlb",
        event_id: g.id,
        home_team: g.home_team,
        away_team: g.away_team,
        market: mkt,
        side: outcome?.name || g.home_team,
        line: outcome?.point || null,
        price: outcome?.price || 2.0,
        commence_time: g.commence_time,
      });
    }

    // Encrypt with SDK
    const validators = networkConfig.validators.map((v) => ({
      uid: v.uid,
      pubkey: v.hotkey || "",
    }));
    const shamirK = networkConfig.shamir?.k || networkConfig.shamir_k || 2;

    const encrypted = await encryptSignal({
      pick: realPick,
      decoys,
      validators,
      shamirK,
    });

    // Generate signal ID
    const signalId = BigInt("0x" + toHex(crypto.getRandomValues(new Uint8Array(32))));
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 8 * 3600);
    const serializedLines = [...decoys, realPick].map((l) => JSON.stringify(l));

    // On-chain commit
    const scContract = new ethers.Contract(CONTRACTS.signalCommitment, SIGNAL_COMMITMENT_ABI, wallet);
    const commitTx = await scContract.commit({
      signalId,
      encryptedBlob: "0x" + encrypted.blob,
      commitHash: "0x" + encrypted.hash,
      sport: "baseball_mlb",
      maxPriceBps: 500n,
      slaMultiplierBps: 15000n,
      maxNotional: 100n * 1000000n,
      minNotional: 1n * 1000000n,
      expiresAt,
      decoyLines: serializedLines,
      availableSportsbooks: ["DraftKings", "FanDuel", "BetOnline"],
    });
    const receipt = await commitTx.wait();
    log("OK", `  Signal #${idx + 1} on-chain: block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

    // Distribute shares directly to validators (like the frontend does)
    const signalIdStr = commitTx.hash.replace(/^0x/, "").slice(0, 64);
    const shareResults = await Promise.allSettled(
      encrypted.shares.map(async (s, i) => {
        const v = networkConfig.validators[i];
        if (!v) return { uid: -1, success: false, reason: "no validator" };
        const endpoint = v.endpoint || `http://${v.ip}:${v.port}`;
        const shareY = s.keyShare;
        const encKeyShare = s.indexShare || s.keyShare;

        const resp = await fetch(`${endpoint}/v1/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal_id: signalIdStr,
            genius_address: wallet.address,
            share_x: s.shareX,
            share_y: shareY,
            encrypted_key_share: encKeyShare,
            encrypted_index_share: s.indexShare || "",
            shamir_threshold: shamirK,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return { uid: v.uid, success: false, reason: `HTTP ${resp.status}: ${text.slice(0, 100)}` };
        }
        return { uid: v.uid, success: true, reason: "" };
      }),
    );

    let accepted = 0;
    let totalV = shareResults.length;
    for (const sr of shareResults) {
      if (sr.status === "fulfilled" && sr.value.success) {
        accepted++;
      } else {
        const reason = sr.status === "fulfilled" ? sr.value.reason : sr.reason?.message || "unknown";
        log("WARN", `    Validator ${sr.status === "fulfilled" ? "UID " + sr.value.uid : "?"}: ${reason.slice(0, 80)}`);
      }
    }

    if (accepted === 0) {
      result.error = `No validators accepted shares (${totalV} attempted)`;
      result.createMs = Date.now() - start;
      return result;
    }

    result.signalId = signalId.toString();
    result.createMs = Date.now() - start;
    result.validatorsAccepted = accepted;
    result.validatorsTotal = totalV;
    log("OK", `  Signal #${idx + 1} created: ID=${signalIdStr.slice(0, 16)}... shares=${accepted}/${totalV} (${(result.createMs / 1000).toFixed(1)}s)`);
    return result;
  } catch (err) {
    result.error = err.message?.slice(0, 300) || String(err);
    result.createMs = Date.now() - start;
    log("FAIL", `  Signal #${idx + 1} FAILED: ${result.error.slice(0, 150)}`);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Signal purchase
// ---------------------------------------------------------------------------

let cycleLimitHit = false; // Track if we've hit the cycle limit for this genius-idiot pair

async function purchaseSignal(signalId, wallet, provider, authHeaders) {
  const start = Date.now();
  const result = { signalId, purchaseMs: 0, success: false, error: null };

  // Skip if we already know this pair hit the cycle limit
  if (cycleLimitHit) {
    result.error = "Skipped: cycle limit reached for this genius-idiot pair";
    result.purchaseMs = Date.now() - start;
    log("WARN", `  Skipped (cycle limit already reached)`);
    return result;
  }

  try {
    // Get signal details to determine odds
    let odds = 2_000_000n; // Default: 2.0x (even odds)
    try {
      const sc = new ethers.Contract(CONTRACTS.signalCommitment, SIGNAL_COMMITMENT_ABI, provider);
      const signalData = await sc.getSignal(BigInt(signalId));
      if (signalData.decoyLines?.length > 0) {
        try {
          const firstLine = JSON.parse(signalData.decoyLines[0]);
          if (firstLine.price && firstLine.price > 1.01) {
            odds = BigInt(Math.round(firstLine.price * 1e6));
          }
        } catch {}
      }
    } catch {}

    // Direct on-chain purchase
    const notional = 10n * 1000000n; // $10 USDC (6 decimals)
    const escrowContract = new ethers.Contract(CONTRACTS.escrow, ESCROW_ABI, wallet);
    const tx = await escrowContract.purchase(BigInt(signalId), notional, odds);
    const receipt = await tx.wait();
    result.success = true;
    result.purchaseMs = Date.now() - start;
    result.gas = receipt.gasUsed.toString();
    log("OK", `  Purchase OK: block ${receipt.blockNumber}, gas ${receipt.gasUsed}, odds=${Number(odds) / 1e6}x (${(result.purchaseMs / 1000).toFixed(1)}s)`);
    return result;
  } catch (err) {
    result.error = err.message?.slice(0, 300) || String(err);
    result.purchaseMs = Date.now() - start;

    // Detect cycle limit error (selector 0x75f3fe47 = CycleSignalLimitReached)
    if (result.error.includes("0x75f3fe47") || result.error.includes("CycleSignalLimit")) {
      cycleLimitHit = true;
      result.error = "CycleSignalLimitReached (10 purchases per genius-idiot pair per cycle)";
      log("WARN", `  Cycle limit reached. Remaining purchases will be skipped.`);
    } else {
      log("FAIL", `  Purchase FAILED: ${result.error.slice(0, 150)}`);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("INFO", "=== Djinn Signal Stress Test ===");
  log("INFO", `Target: ${TARGET} signals`);
  log("INFO", `API: ${BASE_URL}`);
  log("INFO", `Purchase: ${SKIP_PURCHASE ? "skipped" : "enabled"}`);

  if (!GENIUS_PRIVATE_KEY) {
    log("FATAL", "Set E2E_TEST_PRIVATE_KEY or E2E_GENIUS_KEY in env (source web/.env)");
    process.exit(1);
  }
  if (!DEPLOYER_PRIVATE_KEY) {
    log("FATAL", "Set E2E_DEPLOYER_KEY in env (source web/.env)");
    process.exit(1);
  }

  // Set up provider and wallets
  const provider = createProvider();
  const geniusWallet = new ethers.Wallet(GENIUS_PRIVATE_KEY, provider);
  const deployerWallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  log("INFO", `Genius:   ${geniusWallet.address}`);
  log("INFO", `Deployer: ${deployerWallet.address}`);

  // Check genius balances
  const usdcContractR = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, provider);
  const gEth = await retry(() => provider.getBalance(geniusWallet.address), 3, "genius ETH");
  log("INFO", `Genius ETH: ${(Number(gEth) / 1e18).toFixed(6)}`);

  // Fund genius with ETH if low (need ~0.0005 ETH per signal commit on Base Sepolia)
  const ethNeeded = BigInt(TARGET) * 500000000000000n; // 0.0005 ETH per signal
  if (gEth < ethNeeded) {
    const deficit = ethNeeded - gEth + 1000000000000000n; // extra 0.001 buffer
    const dEth = await retry(() => provider.getBalance(deployerWallet.address), 3, "deployer ETH");
    log("INFO", `Genius needs ~${(Number(deficit) / 1e18).toFixed(4)} ETH. Deployer has ${(Number(dEth) / 1e18).toFixed(4)} ETH`);
    if (dEth > deficit + 100000000000000n) { // deployer needs gas too
      const fundTx = await deployerWallet.sendTransaction({
        to: geniusWallet.address,
        value: deficit,
      });
      await fundTx.wait();
      const newBal = await retry(() => provider.getBalance(geniusWallet.address), 3, "genius ETH");
      log("OK", `Funded genius: ${(Number(newBal) / 1e18).toFixed(6)} ETH`);
    } else {
      log("WARN", `Deployer also low on ETH, proceeding anyway`);
    }
  }

  // Ensure collateral (genius)
  const collContract = new ethers.Contract(CONTRACTS.collateral, COLLATERAL_ABI, geniusWallet);
  const collDep = await retry(() => collContract.getDeposit(geniusWallet.address), 3, "collateral");
  log("INFO", `Collateral: $${(Number(collDep) / 1e6).toFixed(2)}`);

  if (Number(collDep) < 100e6) {
    log("INFO", "Depositing collateral...");
    const usdcSigner = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, geniusWallet);
    const needed = 10000n * 1000000n;
    const appTx = await usdcSigner.approve(CONTRACTS.collateral, needed);
    await appTx.wait();
    const depTx = await collContract.deposit(needed);
    await depTx.wait();
    log("OK", "Deposited $10,000 collateral");
  }

  // Create fresh idiot wallet to avoid cycle limits
  // Derive deterministically so we can reuse if re-running on same day
  const idiotSeed = ethers.keccak256(ethers.solidityPacked(
    ["string", "uint256"],
    ["stress-test-idiot-v2", BigInt(Math.floor(Date.now() / 86400000))],
  ));
  const idiotWallet = new ethers.Wallet(idiotSeed, provider);
  log("INFO", `Idiot: ${idiotWallet.address} (derived, fresh cycle)`);

  // Ensure idiot wallet is funded
  if (!SKIP_PURCHASE) {
    try {
      // Fund with minimal ETH
      const iBal = await retry(() => provider.getBalance(idiotWallet.address), 3, "idiot ETH");
      if (iBal < 500000000000000n) { // < 0.0005 ETH
        log("INFO", "Funding idiot with ETH...");
        const fundTx = await deployerWallet.sendTransaction({
          to: idiotWallet.address,
          value: 2000000000000000n, // 0.002 ETH
        });
        await fundTx.wait();
        log("OK", "  Funded 0.002 ETH");
      }

      // Mint USDC to idiot
      const iUsdc = await retry(() => usdcContractR.balanceOf(idiotWallet.address), 3, "idiot USDC");
      if (Number(iUsdc) < 10000e6) {
        log("INFO", "Minting USDC to idiot...");
        const mintC = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, deployerWallet);
        const mintTx = await mintC.mint(idiotWallet.address, 50000n * 1000000n);
        await mintTx.wait();
        log("OK", "  Minted 50k USDC");
      }

      // Approve + deposit to escrow
      const escrowR = new ethers.Contract(CONTRACTS.escrow, ESCROW_ABI, provider);
      const escBal = await retry(() => escrowR.getBalance(idiotWallet.address), 3, "escrow");
      log("INFO", `Idiot Escrow: $${(Number(escBal) / 1e6).toFixed(2)}`);
      if (Number(escBal) < 500e6) {
        log("INFO", "Setting up idiot escrow...");
        const iUsdcS = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, idiotWallet);
        const appTx = await iUsdcS.approve(CONTRACTS.escrow, ethers.MaxUint256);
        await appTx.wait();
        await new Promise((r) => setTimeout(r, 2000));
        const escS = new ethers.Contract(CONTRACTS.escrow, ESCROW_ABI, idiotWallet);
        const depTx = await escS.deposit(5000n * 1000000n);
        await depTx.wait();
        log("OK", "  Deposited $5,000 to escrow");
      }
    } catch (e) {
      log("WARN", `Idiot setup failed: ${e.message?.slice(0, 100)}`);
      if (!SKIP_PURCHASE) {
        log("WARN", "Falling back to deployer as idiot");
      }
    }
  }

  // Authenticate (genius)
  log("INFO", "Authenticating genius...");
  const sessionToken = await authenticate(geniusWallet);
  const authHeaders = { Authorization: `Bearer ${sessionToken}` };
  log("OK", "Authenticated");

  // Fetch network config
  log("INFO", "Fetching network config...");
  const { json: networkConfig } = await api("/api/network/config", { timeout: 30_000 });
  if (!networkConfig?.validators?.length) {
    // Fallback: use validators/discover
    const { json: discoverData } = await api("/api/validators/discover", { timeout: 30_000 });
    networkConfig.validators = discoverData.validators || [];
    if (!networkConfig.shamir) networkConfig.shamir = { k: 2, n: 3 };
  }
  log("INFO", `Validators: ${networkConfig.validators?.length || 0}, Shamir k=${networkConfig.shamir?.k || "?"}`);

  // Fetch live MLB odds
  log("INFO", "Fetching MLB odds...");
  const { json: oddsRaw } = await api("/api/odds?sport=baseball_mlb", { timeout: 20_000 });
  const oddsData = Array.isArray(oddsRaw) ? oddsRaw : [];
  if (oddsData.length === 0) {
    log("FATAL", "No MLB games available. Cannot create signals.");
    process.exit(1);
  }
  // Filter to future games only
  const now = new Date();
  const futureGames = oddsData.filter((g) => new Date(g.commence_time) > now);
  log("INFO", `MLB: ${oddsData.length} total games, ${futureGames.length} future games`);
  const gamesToUse = futureGames.length >= 3 ? futureGames : oddsData;

  // =========================================================================
  // Phase 1: Create signals
  // =========================================================================
  log("INFO", "\n========== PHASE 1: SIGNAL CREATION ==========");
  const createResults = [];

  for (let i = 0; i < TARGET; i++) {
    log("INFO", `\n--- Signal ${i + 1}/${TARGET} ---`);
    const result = await createOneSignal(i, geniusWallet, provider, networkConfig, gamesToUse, authHeaders);
    createResults.push(result);

    // Small delay between signals to avoid nonce issues
    if (i < TARGET - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const created = createResults.filter((r) => r.signalId);
  const createFailed = createResults.filter((r) => !r.signalId);
  log("INFO", `\nCreation complete: ${created.length}/${TARGET} succeeded, ${createFailed.length} failed`);

  // =========================================================================
  // Phase 2: Purchase signals
  // =========================================================================
  const purchaseResults = [];

  if (!SKIP_PURCHASE && created.length > 0) {
    log("INFO", "\n========== PHASE 2: SIGNAL PURCHASE ==========");
    log("INFO", "Waiting 10s for share propagation...");
    await new Promise((r) => setTimeout(r, 10_000));

    for (let i = 0; i < created.length; i++) {
      const sig = created[i];
      log("INFO", `\n--- Purchase ${i + 1}/${created.length} (Signal #${sig.idx + 1}: ${sig.game}) ---`);
      const result = await purchaseSignal(sig.signalId, idiotWallet, provider, authHeaders);
      purchaseResults.push(result);

      if (i < created.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // =========================================================================
  // Report
  // =========================================================================
  log("INFO", "\n================================================");
  log("INFO", "         STRESS TEST RESULTS");
  log("INFO", "================================================");
  log("INFO", `\nSignal Creation: ${created.length}/${TARGET} succeeded`);

  if (created.length > 0) {
    const ct = created.map((r) => r.createMs);
    log("INFO", `  Min: ${(Math.min(...ct) / 1000).toFixed(1)}s`);
    log("INFO", `  Max: ${(Math.max(...ct) / 1000).toFixed(1)}s`);
    log("INFO", `  Avg: ${(ct.reduce((a, b) => a + b, 0) / ct.length / 1000).toFixed(1)}s`);
    log("INFO", `  Total: ${(ct.reduce((a, b) => a + b, 0) / 1000).toFixed(1)}s`);
  }

  if (createFailed.length > 0) {
    log("INFO", `\nCreation Failures:`);
    for (const f of createFailed) {
      log("INFO", `  #${f.idx + 1}: ${f.error?.slice(0, 100)}`);
    }
  }

  if (purchaseResults.length > 0) {
    const purchased = purchaseResults.filter((r) => r.success);
    const purchaseFailed = purchaseResults.filter((r) => !r.success);
    log("INFO", `\nSignal Purchase: ${purchased.length}/${purchaseResults.length} succeeded`);

    if (purchased.length > 0) {
      const pt = purchased.map((r) => r.purchaseMs);
      log("INFO", `  Min: ${(Math.min(...pt) / 1000).toFixed(1)}s`);
      log("INFO", `  Max: ${(Math.max(...pt) / 1000).toFixed(1)}s`);
      log("INFO", `  Avg: ${(pt.reduce((a, b) => a + b, 0) / pt.length / 1000).toFixed(1)}s`);
    }

    if (purchaseFailed.length > 0) {
      log("INFO", `\nPurchase Failures:`);
      for (const f of purchaseFailed) {
        log("INFO", `  Signal ${f.signalId?.slice(0, 16)}...: ${f.error?.slice(0, 100)}`);
      }
    }
  }

  // Write TSV results
  const tsvFile = `test-results/signal-stress-${new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")}.tsv`;
  const header = "idx\tsport\tgame\tcreate_s\tsignal_id\tshares_ok\tpurchase_s\tpurchase_ok\terror\n";
  const rows = createResults.map((c) => {
    const p = purchaseResults.find((pr) => pr.signalId === c.signalId);
    return [
      c.idx + 1,
      c.sport,
      c.game,
      (c.createMs / 1000).toFixed(1),
      c.signalId?.slice(0, 20) || "",
      c.validatorsAccepted || 0,
      p ? (p.purchaseMs / 1000).toFixed(1) : "",
      p ? p.success : "",
      c.error || p?.error || "",
    ].join("\t");
  }).join("\n");
  try {
    writeFileSync(tsvFile, header + rows + "\n");
    log("INFO", `\nResults written to ${tsvFile}`);
  } catch {}

  // Per-signal detail table
  log("INFO", "\n--- Per-Signal Detail ---");
  for (const c of createResults) {
    const p = purchaseResults.find((pr) => pr.signalId === c.signalId);
    const createSt = c.signalId ? "OK" : "FAIL";
    const purchaseSt = p ? (p.success ? "OK" : "FAIL") : "N/A";
    log("INFO", `  #${c.idx + 1} ${c.game.slice(0, 30).padEnd(30)} create=${(c.createMs / 1000).toFixed(1).padStart(5)}s [${createSt}] purchase=${p ? (p.purchaseMs / 1000).toFixed(1).padStart(5) + "s" : "  N/A"} [${purchaseSt}]${(c.error || p?.error) ? ` (${(c.error || p?.error).slice(0, 60)})` : ""}`);
  }

  log("INFO", "\n=== Stress Test Complete ===");
  process.exit(createFailed.length > 0 || purchaseResults.some((r) => !r.success) ? 1 : 0);
}

main().catch((err) => {
  log("FATAL", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
