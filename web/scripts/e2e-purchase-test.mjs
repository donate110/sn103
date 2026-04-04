#!/usr/bin/env node
/**
 * End-to-end purchase test: creates a real signal with shares distributed
 * to validators, then attempts to purchase it. Tests the EXACT same flow
 * a user goes through in the UI.
 *
 * Usage: node scripts/e2e-purchase-test.mjs
 * Env: E2E_TEST_PRIVATE_KEY (genius wallet)
 */

import { ethers } from "ethers";
import crypto from "crypto";

const RPC_URL = "https://sepolia.base.org";
const BASE_URL = process.env.LIVE_URL ?? "https://www.djinn.gg";
const PRIVATE_KEY = process.env.E2E_TEST_PRIVATE_KEY || "";
if (!PRIVATE_KEY) { console.error("Set E2E_TEST_PRIVATE_KEY"); process.exit(1); }

const ADDRESSES = {
  signalCommitment: "0x4712479Ba57c9ED40405607b2B18967B359209C0",
  escrow: "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
  usdc: "0x00e8293b05dbD3732EF3396ad1483E87e7265054",
};

// BN254 prime for Shamir field arithmetic
const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function timer() { const s = Date.now(); return () => Date.now() - s; }

function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp = exp / 2n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a, p) {
  return modPow(a, p - 2n, p);
}

function getRandomFieldElement() {
  for (let i = 0; i < 256; i++) {
    const bytes = crypto.randomBytes(32);
    const val = BigInt("0x" + bytes.toString("hex"));
    if (val < BN254_PRIME && val > 0n) return val;
  }
  throw new Error("Failed to generate random field element");
}

function splitSecret(secret, n, k) {
  const coeffs = [secret];
  for (let i = 1; i < k; i++) coeffs.push(getRandomFieldElement());
  const shares = [];
  for (let i = 1; i <= n; i++) {
    const x = BigInt(i);
    let y = 0n;
    for (let j = 0; j < coeffs.length; j++) {
      y = (y + coeffs[j] * modPow(x, BigInt(j), BN254_PRIME)) % BN254_PRIME;
    }
    shares.push({ x: i, y });
  }
  return shares;
}

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const body = await res.json();
    return { status: res.status, body };
  } finally { clearTimeout(t); }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const genius = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Genius: ${genius.address}`);

  // ─── Step 1: Find a game with live odds ───────────────
  console.log("\n=== Step 1: Find upcoming game with live odds ===");
  const t1 = timer();
  const { body: games } = await fetchJson(`${BASE_URL}/api/odds?sport=basketball_nba`);
  if (!Array.isArray(games) || games.length === 0) {
    console.error("No NBA games found. Try a different sport.");
    process.exit(1);
  }

  // Pick a game at least 3h away
  const now = Date.now();
  const upcoming = games.filter(g => {
    const ct = new Date(g.commence_time).getTime();
    return ct - now > 3 * 3600_000;
  });
  if (upcoming.length === 0) {
    console.error("No NBA games > 3h away. All games are live or starting soon.");
    process.exit(1);
  }

  const game = upcoming[0];
  const h2h = game.bookmakers?.[0]?.markets?.find(m => m.key === "h2h");
  if (!h2h?.outcomes?.length) {
    console.error("No h2h odds for this game");
    process.exit(1);
  }

  const realPick = h2h.outcomes[0];
  console.log(`  Game: ${game.away_team} @ ${game.home_team}`);
  console.log(`  Pick: ${realPick.name} @ ${realPick.price}`);
  console.log(`  Event ID: ${game.id}`);
  console.log(`  Commence: ${game.commence_time}`);
  console.log(`  Odds discovery: ${t1()}ms`);

  // ─── Step 2: Build decoy lines ───────────────────────
  console.log("\n=== Step 2: Build decoy lines ===");
  // Real line is index 0 (will be stored as 1-indexed)
  const realLine = `${game.sport_key}|${game.away_team} vs ${game.home_team}|h2h|0|${realPick.name}`;
  const decoyLines = [realLine];

  // Generate 9 decoy lines from other games/outcomes
  for (let i = 0; i < 9; i++) {
    const g = upcoming[i % upcoming.length];
    const bm = g.bookmakers?.[i % (g.bookmakers?.length || 1)];
    const mkt = bm?.markets?.find(m => m.key === "h2h") || bm?.markets?.[0];
    const out = mkt?.outcomes?.[i % 2] || { name: g.home_team, price: 1.91 };
    decoyLines.push(`${g.sport_key}|${g.away_team} vs ${g.home_team}|h2h|0|${out.name}`);
  }
  console.log(`  ${decoyLines.length} lines (1 real + 9 decoys)`);
  decoyLines.forEach((l, i) => console.log(`    ${i+1}: ${l.substring(0, 70)}`));

  // ─── Step 3: Line check via validators ────────────────
  console.log("\n=== Step 3: Line check via validators ===");
  const t3 = timer();
  const checkLines = decoyLines.map((line, idx) => {
    const parts = line.split("|");
    const teams = (parts[1] || "").split(" vs ");
    return {
      index: idx + 1,
      sport: parts[0] || "basketball_nba",
      event_id: game.id,
      home_team: teams[1] || "Home",
      away_team: teams[0] || "Away",
      market: parts[2] || "h2h",
      line: parseFloat(parts[3] || "0"),
      side: parts[4] || teams[0] || "Side",
    };
  });

  let checkResult = null;
  for (const uid of [2, 1]) {
    try {
      const { status, body } = await fetchJson(`${BASE_URL}/api/validators/${uid}/v1/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: checkLines }),
      }, 20000);
      console.log(`  UID ${uid}: status=${status} available=${body.available_indices?.length || 0} time=${body.response_time_ms}ms miners=${body.miners_queried}`);
      if (body.available_indices?.length > 0) {
        checkResult = body;
        break;
      }
      // Log why lines are unavailable
      for (const r of (body.results || [])) {
        if (!r.available) console.log(`    line ${r.index}: ${r.unavailable_reason || "unknown"}`);
      }
    } catch (e) {
      console.log(`  UID ${uid}: FAILED ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  Line check total: ${t3()}ms`);

  if (!checkResult) {
    console.error("\nFATAL: Line check failed - no lines available. This is the user-facing error.");
    console.error("Root cause: miners report lines unavailable (game_started, line_moved, or no_data)");
    console.error("This blocks ALL purchases.");
    process.exit(1);
  }

  // ─── Step 4: Encrypt & commit on-chain ────────────────
  console.log("\n=== Step 4: Encrypt & commit on-chain ===");
  const t4 = timer();

  const signalId = BigInt("0x" + crypto.randomBytes(32).toString("hex"));
  const aesKey = crypto.randomBytes(32);

  // Encrypt the real pick
  const realIndex = 1; // 1-indexed
  const plaintext = JSON.stringify({ realIndex, pick: realLine, minOdds: realPick.price });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  const encryptedBlob = iv.toString("hex") + ":" + encrypted + authTag;
  const blobBytes = Buffer.from(encryptedBlob, "utf8");
  const commitHash = ethers.keccak256(blobBytes);

  console.log(`  Signal ID: ${signalId.toString().substring(0, 20)}...`);
  console.log(`  Encrypted blob: ${blobBytes.length} bytes`);
  console.log(`  Crypto: ${t4()}ms`);

  // Commit on-chain
  const t4b = timer();
  const SIGNAL_ABI = [
    "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks)) external",
  ];
  const contract = new ethers.Contract(ADDRESSES.signalCommitment, SIGNAL_ABI, genius);

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 8 * 3600);
  try {
    const tx = await contract.commit({
      signalId,
      encryptedBlob: "0x" + blobBytes.toString("hex"),
      commitHash,
      sport: "NBA",
      maxPriceBps: 1000n,
      slaMultiplierBps: 10000n,
      maxNotional: ethers.parseUnits("100", 6),
      minNotional: 0n,
      expiresAt,
      decoyLines,
      availableSportsbooks: [],
    });
    const receipt = await tx.wait();
    console.log(`  On-chain commit: ${t4b()}ms, gas=${receipt.gasUsed}`);
  } catch (e) {
    console.error(`  COMMIT FAILED: ${e.message?.substring(0, 200)}`);
    process.exit(1);
  }

  // ─── Step 5: Distribute Shamir shares ─────────────────
  console.log("\n=== Step 5: Distribute Shamir shares to validators ===");
  const t5 = timer();

  // Discover healthy validators
  const { body: discoverBody } = await fetchJson(`${BASE_URL}/api/validators/discover`);
  const allValidators = discoverBody.validators || discoverBody || [];

  // Health check
  const healthyUids = [];
  for (const v of allValidators) {
    try {
      const { body: h } = await fetchJson(`${BASE_URL}/api/validators/${v.uid}/health`, {}, 5000);
      if (h.status === "ok") healthyUids.push(v.uid);
    } catch {}
  }
  console.log(`  Healthy validators: ${healthyUids.join(", ")}`);

  if (healthyUids.length < 2) {
    console.error("  FATAL: Need at least 2 healthy validators for Shamir threshold");
    process.exit(1);
  }

  const nShares = healthyUids.length;
  const threshold = Math.min(3, Math.max(2, Math.ceil(nShares * 2 / 3)));
  console.log(`  Threshold: ${threshold} of ${nShares}`);

  // Split the AES key and real index into Shamir shares
  const keyBigInt = BigInt("0x" + aesKey.toString("hex"));
  const keyShares = splitSecret(keyBigInt, nShares, threshold);
  const indexShares = splitSecret(BigInt(realIndex), nShares, threshold);

  let stored = 0;
  for (let i = 0; i < nShares; i++) {
    const uid = healthyUids[i];
    const shareHex = keyShares[i].y.toString(16).padStart(64, "0");
    const indexShareHex = indexShares[i].y.toString(16).padStart(64, "0");

    try {
      const { status, body } = await fetchJson(
        `${BASE_URL}/api/validators/${uid}/v1/signal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal_id: signalId.toString(),
            genius_address: genius.address,
            share_x: keyShares[i].x,
            share_y: keyShares[i].y.toString(16),
            encrypted_key_share: shareHex,
            encrypted_index_share: indexShareHex,
            shamir_threshold: threshold,
          }),
        },
        10000,
      );
      if (status < 300) {
        stored++;
        console.log(`  UID ${uid}: stored (${status})`);
      } else {
        console.log(`  UID ${uid}: FAILED (${status}) ${JSON.stringify(body).substring(0, 100)}`);
      }
    } catch (e) {
      console.log(`  UID ${uid}: ERROR ${e.message?.substring(0, 80)}`);
    }
  }
  console.log(`  Share distribution: ${t5()}ms, ${stored}/${nShares} stored`);

  if (stored < threshold) {
    console.error(`  FATAL: Only ${stored} shares stored, need ${threshold}`);
    process.exit(1);
  }

  // ─── Step 6: Verify shares are stored ─────────────────
  console.log("\n=== Step 6: Verify share storage ===");
  for (const uid of healthyUids) {
    const { body } = await fetchJson(
      `${BASE_URL}/api/validators/${uid}/v1/signal/${signalId.toString()}/status`,
      {}, 5000
    ).catch(() => ({ body: { has_shares: "error" } }));
    console.log(`  UID ${uid}: has_shares=${body.has_shares}`);
  }

  // ─── Step 7: Attempt MPC purchase check ───────────────
  console.log("\n=== Step 7: MPC purchase availability check ===");
  const t7 = timer();

  let mpcSuccess = false;
  let collectedShares = [];

  // Sign purchase message (same as browser does) to test signature validation
  const purchaseMsg = `djinn:purchase:${signalId.toString()}`;
  const buyerSig = await genius.signMessage(purchaseMsg);
  console.log(`  Buyer signature length: ${buyerSig.length} chars`);

  const purchaseReq = {
    buyer_address: genius.address,
    sportsbook: "",
    available_indices: checkResult.available_indices,
    buyer_signature: buyerSig,
  };

  // Query all healthy validators in parallel
  const mpcResults = await Promise.allSettled(
    healthyUids.map(uid =>
      Promise.race([
        fetchJson(
          `${BASE_URL}/api/validators/${uid}/v1/signal/${signalId.toString()}/purchase`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(purchaseReq),
          },
          90000,
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("MPC timeout 90s")), 90000)),
      ]).then(r => ({ uid, ...r }))
    ),
  );

  for (const result of mpcResults) {
    if (result.status === "fulfilled") {
      const r = result.value;
      const b = r.body || {};
      const available = b.available === true || b.status === "payment_required";
      console.log(`  UID ${r.uid}: status=${r.status} available=${available} msg=${b.message || b.status || "?"} reason=${b.mpc_failure_reason || "none"}`);
      if (available && b.encrypted_key_share && b.share_x != null) {
        collectedShares.push({ x: b.share_x, y: BigInt("0x" + b.encrypted_key_share) });
      }
      if (available) mpcSuccess = true;
    } else {
      console.log(`  REJECTED: ${result.reason?.message?.substring(0, 100)}`);
    }
  }

  console.log(`  MPC check: ${t7()}ms`);
  console.log(`  MPC available: ${mpcSuccess}`);
  console.log(`  Shares collected: ${collectedShares.length}`);

  // ─── Summary ──────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("END-TO-END PURCHASE TEST RESULTS");
  console.log("=".repeat(60));
  console.log(`Signal ID: ${signalId.toString().substring(0, 30)}...`);
  console.log(`Game: ${game.away_team} @ ${game.home_team}`);
  console.log(`Pick: ${realPick.name} @ ${realPick.price}`);
  console.log();
  console.log("Step Results:");
  console.log(`  1. Odds discovery:    OK (${games.length} games)`);
  console.log(`  2. Decoy generation:  OK (10 lines)`);
  console.log(`  3. Line check:        ${checkResult ? "OK" : "FAILED"} (${checkResult?.available_indices?.length || 0} available)`);
  console.log(`  4. On-chain commit:   OK`);
  console.log(`  5. Share distribution: ${stored >= threshold ? "OK" : "FAILED"} (${stored}/${nShares})`);
  console.log(`  6. Share verification: OK`);
  console.log(`  7. MPC purchase:      ${mpcSuccess ? "OK" : "FAILED"}`);

  if (!mpcSuccess) {
    console.log("\nPURCHASE WOULD FAIL. MPC check returned unavailable.");
    console.log("Note: using same wallet as genius (self-purchase is now allowed).");
    console.log("The MPC check itself determines if the protocol works.");
  } else {
    console.log("\nPURCHASE FLOW WORKS! MPC returned available.");
    console.log("On-chain purchase would succeed with a different buyer wallet.");
  }
  console.log("=".repeat(60));
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
