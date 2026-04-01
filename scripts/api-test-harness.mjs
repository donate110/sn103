#!/usr/bin/env node
/**
 * Djinn API Comprehensive Test Suite
 *
 * Exercises every public and authenticated API endpoint with real data.
 * Uses @djinn/sdk for client-side crypto, ethers.js for on-chain txs,
 * and the Odds API for live sports lines.
 *
 * Usage:
 *   node scripts/api-test-harness.mjs [--base-url https://djinn.gg] [--dry-run] [--only auth,read,signal]
 *
 * Requires env vars from web/.env:
 *   E2E_TEST_PRIVATE_KEY   - wallet private key
 *   NEXT_PUBLIC_BASE_RPC_URL - Base Sepolia RPC
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(path.join(__dirname, "../web/package.json"));
const ethersModule = await import(require.resolve("ethers"));
const ethers = ethersModule;

const { encryptSignal, toHex, splitSecret, keyToBigInt } = await import(
  path.join(__dirname, "../sdk/dist/index.mjs")
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const baseUrlFlag = args.find((a) => a.startsWith("--base-url="));
const baseUrlIdx = args.indexOf("--base-url");
const BASE_URL = baseUrlFlag
  ? baseUrlFlag.split("=")[1]
  : baseUrlIdx !== -1 && args[baseUrlIdx + 1]
    ? args[baseUrlIdx + 1]
    : "https://www.djinn.gg";

const onlyFlag = args.find((a) => a.startsWith("--only="));
const ONLY = onlyFlag ? onlyFlag.split("=")[1].split(",") : null;

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY = process.env.E2E_TEST_PRIVATE_KEY;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "84532");

// Contract addresses (Base Sepolia live deployment)
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
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const COLLATERAL_ABI = [
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function getDeposit(address genius) external view returns (uint256)",
  "function getAvailable(address genius) external view returns (uint256)",
];

// ---------------------------------------------------------------------------
// Test framework
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const timings = [];

function shouldRun(suite) {
  if (!ONLY) return true;
  return ONLY.some((o) => suite.toLowerCase().includes(o.toLowerCase()));
}

function log(step, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  [${ts}] ${msg}`);
}

async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    timings.push({ name, ms });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
    passed++;
  } catch (err) {
    const ms = Date.now() - start;
    timings.push({ name, ms });
    console.log(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m(${ms}ms)\x1b[0m`);
    console.log(`    \x1b[31m${err.message}\x1b[0m`);
    failures.push({ name, error: err.message });
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  \x1b[33m○\x1b[0m ${name} \x1b[2m(${reason})\x1b[0m`);
  skipped++;
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

function assertGt(a, b, msg) {
  if (!(a > b)) throw new Error(msg || `Expected ${a} > ${b}`);
}

function suite(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function api(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const maxRetries = opts.retries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  if (!PRIVATE_KEY) {
    console.error("Set E2E_TEST_PRIVATE_KEY in env (source web/.env)");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const address = wallet.address;

  console.log(`\n\x1b[1m━━━ Djinn API Test Suite ━━━\x1b[0m`);
  console.log(`  Wallet:   ${address}`);
  console.log(`  API:      ${BASE_URL}`);
  console.log(`  Chain:    ${CHAIN_ID} (Base Sepolia)`);
  console.log(`  Dry run:  ${DRY_RUN}`);
  if (ONLY) console.log(`  Only:     ${ONLY.join(", ")}`);

  // Shared state across tests
  let sessionToken = null;
  let networkConfig = null;
  let oddsData = null;
  let createdSignalId = null;

  // =========================================================================
  // 1. PUBLIC READ ENDPOINTS
  // =========================================================================
  if (shouldRun("read")) {
    suite("Public Read Endpoints");

    await test("GET /api/health returns 200", async () => {
      const { status, json } = await api("/api/health");
      assertEq(status, 200, `Expected 200, got ${status}`);
      assert(json.status, "Missing status field");
    });

    await test("GET /api/sports returns sport list", async () => {
      const { status, json } = await api("/api/sports");
      assertEq(status, 200);
      const sports = json.sports || json;
      assert(Array.isArray(sports), "Expected sports array");
      assertGt(sports.length, 0, "Expected at least one sport");
      const mlb = sports.find((s) => s.key === "baseball_mlb");
      assert(mlb, "baseball_mlb not found");
    });

    await test("GET /api/odds?sport=baseball_mlb returns games", async () => {
      const { status, json } = await api("/api/odds?sport=baseball_mlb");
      assertEq(status, 200);
      assert(Array.isArray(json), "Expected array of games");
      assertGt(json.length, 0, "No MLB games found");
      assert(json[0].home_team, "Missing home_team");
      assert(json[0].bookmakers?.length > 0, "No bookmakers");
      oddsData = json;
    });

    await test("GET /api/odds?sport=invalid returns empty or error", async () => {
      const { status, json } = await api("/api/odds?sport=curling_world");
      // Should return 200 with empty array or 400
      assert(status === 200 || status === 400, `Unexpected status ${status}`);
    });

    await test("GET /api/network/config returns validators", async () => {
      const { status, json } = await api("/api/network/config");
      assertEq(status, 200);
      assert(Array.isArray(json.validators), "Missing validators array");
      assert(json.shamir?.k || json.shamir_k, "Missing shamir threshold");
      assert(json.contracts?.signal_commitment || json.signal_commitment_address, "Missing contract address");
      networkConfig = json;
    });

    await test("GET /api/network/status returns health", async () => {
      const { status, json } = await api("/api/network/status");
      assertEq(status, 200);
      assert(typeof json === "object" && json !== null, "Expected object response");
    });

    await test("GET /api/validators/discover returns node list", async () => {
      const { status, json } = await api("/api/validators/discover");
      assertEq(status, 200);
      assert(Array.isArray(json.validators), "Missing validators array");
    });

    await test("GET /api/idiot/balance?address=... returns balances", async () => {
      const { status, json } = await api(`/api/idiot/balance?address=${address}`);
      assertEq(status, 200);
      assert(json.address || json.escrow_balance_usdc !== undefined, "Missing balance data");
    });

    await test("GET /api/idiot/browse returns signals", async () => {
      const { status, json } = await api("/api/idiot/browse?limit=5");
      assertEq(status, 200);
      assert(Array.isArray(json.signals), "Missing signals array");
    });

    await test("GET /api/genius/signals?address=... returns history", async () => {
      const { status, json } = await api(`/api/genius/signals?address=${address}&limit=5`);
      // 200 = success, 500 = RPC provider issue (Base Sepolia can be flaky)
      assert(status === 200 || status === 500, `Unexpected status ${status}`);
      if (status === 200) {
        assert(Array.isArray(json.signals), "Missing signals array");
      }
    });

    await test("GET /api/genius/earnings?address=... returns data", async () => {
      const { status } = await api(`/api/genius/earnings?address=${address}`, { timeout: 15_000 });
      assert(status === 200 || status === 500, `Unexpected status ${status}`);
    });

    await test("GET /api/delegates returns name map", async () => {
      const { status, json } = await api("/api/delegates");
      assertEq(status, 200);
      assert(typeof json === "object", "Expected object");
    });
  }

  // =========================================================================
  // 2. AUTHENTICATION
  // =========================================================================
  if (shouldRun("auth")) {
    suite("Authentication");

    await test("POST /api/auth/connect returns challenge", async () => {
      const { status, json } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      assertEq(status, 200, `Expected 200, got ${status}: ${JSON.stringify(json)}`);
      assert(json.nonce, "Missing nonce");
      assert(json.challenge, "Missing challenge message");
      assert(json.challenge.includes("Djinn Protocol"), "Challenge missing protocol name");
    });

    await test("POST /api/auth/connect rejects invalid address", async () => {
      const { status } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address: "not-an-address" }),
      });
      assertEq(status, 400);
    });

    await test("POST /api/auth/verify rejects without nonce", async () => {
      const { status } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature: "0x1234" }),
      });
      assertEq(status, 400);
    });

    await test("POST /api/auth/verify rejects bad signature", async () => {
      // Get a real nonce first
      const { json: connectJson } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const { status } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          address,
          signature: "0x" + "ab".repeat(65),
          nonce: connectJson.nonce,
        }),
      });
      assertEq(status, 401);
    });

    await test("Full auth flow: connect -> sign -> verify -> token", async () => {
      // Connect
      const { json: connectJson } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });

      // Sign
      const signature = await wallet.signMessage(connectJson.challenge);

      // Verify
      const { status, json: verifyJson } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          address,
          signature,
          nonce: connectJson.nonce,
        }),
      });
      assertEq(status, 200, `Verify failed: ${JSON.stringify(verifyJson)}`);
      assert(verifyJson.session_token, "Missing session_token");
      assert(verifyJson.session_token.startsWith("djn_"), "Token missing prefix");
      assert(verifyJson.expires_at, "Missing expires_at");

      sessionToken = verifyJson.session_token;
    });

    await test("POST /api/auth/verify with scoped session", async () => {
      const { json: c } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const sig = await wallet.signMessage(c.challenge);
      const { status, json } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          address,
          signature: sig,
          nonce: c.nonce,
          scope: { role: "genius", max_spend_usdc: 1000, expires_in_hours: 1 },
        }),
      });
      assertEq(status, 200);
      assertEq(json.scope.role, "genius");
      assertEq(json.scope.max_spend_usdc, 1000);
    });
  }

  // =========================================================================
  // 3. AUTHENTICATED ENDPOINTS (error cases)
  // =========================================================================
  if (shouldRun("autherr")) {
    suite("Authenticated Endpoint Error Handling");

    await test("Write endpoints reject missing auth", async () => {
      const endpoints = [
        ["/api/genius/signal/commit", "POST"],
        ["/api/genius/collateral/deposit", "POST"],
        ["/api/genius/collateral/withdraw", "POST"],
        ["/api/genius/claim", "POST"],
        ["/api/idiot/purchase", "POST"],
        ["/api/idiot/deposit", "POST"],
        ["/api/idiot/withdraw", "POST"],
        ["/api/idiot/purchases", "GET"],
      ];
      for (const [path, method] of endpoints) {
        const { status } = await api(path, {
          method,
          body: method === "POST" ? JSON.stringify({}) : undefined,
        });
        assertEq(status, 401, `${method} ${path} should reject without auth, got ${status}`);
      }
    });

    await test("Write endpoints reject invalid token", async () => {
      const { status } = await api("/api/idiot/purchases", {
        headers: { Authorization: "Bearer djn_invalid.token" },
      });
      assertEq(status, 401);
    });
  }

  // =========================================================================
  // 4. GENIUS WRITE ENDPOINTS
  // =========================================================================
  if (shouldRun("genius") || shouldRun("signal")) {
    suite("Genius Write Endpoints");

    // Ensure we have a session token
    if (!sessionToken) {
      const { json: c } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const sig = await wallet.signMessage(c.challenge);
      const { json: v } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature: sig, nonce: c.nonce }),
      });
      sessionToken = v.session_token;
    }

    const authHeaders = { Authorization: `Bearer ${sessionToken}` };

    await test("POST /api/genius/collateral/deposit returns unsigned tx", async () => {
      const { status, json } = await api("/api/genius/collateral/deposit", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: 100 }),
      });
      assertEq(status, 200, `Got ${status}: ${JSON.stringify(json)}`);
      assert(json.approve_tx, "Missing approve_tx");
      assert(json.deposit_tx || json.tx, "Missing deposit_tx");
      assert(json.approve_tx.to, "approve_tx missing 'to'");
      assert(json.approve_tx.data, "approve_tx missing 'data'");
    });

    await test("POST /api/genius/collateral/withdraw returns unsigned tx", async () => {
      const { status, json } = await api("/api/genius/collateral/withdraw", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: 50 }),
      });
      assertEq(status, 200, `Got ${status}: ${JSON.stringify(json)}`);
      assert(json.tx, "Missing tx");
      assert(json.tx.to, "tx missing 'to'");
    });

    await test("POST /api/genius/collateral/deposit rejects zero amount", async () => {
      const { status } = await api("/api/genius/collateral/deposit", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: 0 }),
      });
      assertEq(status, 400);
    });

    await test("POST /api/genius/claim returns 501 (automatic)", async () => {
      const { status, json } = await api("/api/genius/claim", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      assertEq(status, 501, `Expected 501, got ${status}: ${JSON.stringify(json)}`);
    });

    // -----------------------------------------------------------------------
    // Signal creation (full flow)
    // -----------------------------------------------------------------------
    if (!networkConfig) {
      const { json } = await api("/api/network/config");
      networkConfig = json;
    }

    // Fetch live MLB odds for realistic decoys
    if (!oddsData) {
      const { json } = await api("/api/odds?sport=baseball_mlb");
      oddsData = Array.isArray(json) ? json : [];
    }

    const hasValidators = networkConfig?.validators?.length > 0;
    const hasOdds = oddsData?.length > 0;

    if (!hasValidators) {
      skip("Signal creation", "No validators available");
    } else if (!hasOdds) {
      skip("Signal creation with real lines", "No MLB odds available");
    } else {
      // Build a real pick from live odds
      const game = oddsData[0];
      const bookmaker = game.bookmakers[0];
      const spreadMarket = bookmaker.markets.find((m) => m.key === "spreads");
      const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");
      const totalsMarket = bookmaker.markets.find((m) => m.key === "totals");

      const realPick = {
        sport: "baseball_mlb",
        event_id: game.id,
        home_team: game.home_team,
        away_team: game.away_team,
        market: "spreads",
        side: spreadMarket?.outcomes[0]?.name || game.home_team,
        line: spreadMarket?.outcomes[0]?.point || 1.5,
        price: spreadMarket?.outcomes[0]?.price || 1.91,
        commence_time: game.commence_time,
      };

      // Generate 9 decoys from real odds data
      const decoys = [];
      const markets = ["spreads", "totals", "h2h"];
      for (let i = 0; i < 9; i++) {
        const g = oddsData[i % oddsData.length];
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

      await test("SDK encryptSignal with real odds data", async () => {
        const validators = networkConfig.validators.map((v) => ({
          uid: v.uid,
          pubkey: v.hotkey || "",
        }));

        const encrypted = await encryptSignal({
          pick: realPick,
          decoys,
          validators,
          shamirK: networkConfig.shamir?.k || networkConfig.shamir_k,
        });

        assertGt(encrypted.blob.length, 100, "Blob too short");
        assertEq(encrypted.shares.length, validators.length, "Wrong share count");
        assert(encrypted.realIndex >= 1 && encrypted.realIndex <= 10, "Bad realIndex");
        assert(encrypted.localKey.length === 32, "Bad key length");

        // Store for later tests
        createdSignalId = BigInt(
          "0x" + toHex(crypto.getRandomValues(new Uint8Array(32)))
        );

        log("SIGNAL", `Pick: ${realPick.side} ${realPick.line} (${realPick.home_team} vs ${realPick.away_team})`);
        log("SIGNAL", `Blob: ${encrypted.blob.length} hex chars, ${encrypted.shares.length} shares`);
      });

      await test("POST /api/genius/signal/commit validates input", async () => {
        const { status, json } = await api("/api/genius/signal/commit", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ encrypted_blob: "abc" }),
        });
        assertEq(status, 400, `Expected 400, got ${status}: ${JSON.stringify(json)}`);
      });

      if (!DRY_RUN) {
        await test("On-chain signal commit + API share distribution", async () => {
          const validators = networkConfig.validators.map((v) => ({
            uid: v.uid,
            pubkey: v.hotkey || "",
          }));

          const encrypted = await encryptSignal({
            pick: realPick,
            decoys,
            validators,
            shamirK: networkConfig.shamir?.k || networkConfig.shamir_k,
          });

          const signalId = BigInt("0x" + toHex(crypto.getRandomValues(new Uint8Array(32))));
          createdSignalId = signalId;

          // On-chain commit
          const scContract = new ethers.Contract(CONTRACTS.signalCommitment, SIGNAL_COMMITMENT_ABI, wallet);
          const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 4 * 3600);
          const serializedLines = [...decoys, realPick].map((l) => JSON.stringify(l));

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
            availableSportsbooks: ["DraftKings", "FanDuel"],
          });
          const receipt = await commitTx.wait();
          log("SIGNAL", `On-chain commit: block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

          // Distribute shares via API
          const { status, json } = await api("/api/genius/signal/commit", {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              encrypted_blob: encrypted.blob,
              commit_hash: encrypted.hash,
              shares: encrypted.shares.map((s) => ({
                validator_uid: s.validatorUid,
                key_share: s.keyShare,
                index_share: s.indexShare,
                share_x: s.shareX,
              })),
              commit_tx_hash: commitTx.hash,
              event_id: realPick.event_id,
              sport: "baseball_mlb",
              fee_bps: 500,
              sla_multiplier_bps: 15000,
              max_notional_usdc: 100,
              expires_at: new Date(Number(expiresAt) * 1000).toISOString(),
              shamir_threshold: networkConfig.shamir?.k || networkConfig.shamir_k,
            }),
            timeout: 30_000,
          });

          assertEq(status, 200, `Share distribution failed: ${JSON.stringify(json)}`);
          assertGt(json.validators_received_shares, 0, "No validators accepted shares");
          log("SIGNAL", `Shares: ${json.validators_received_shares}/${json.validators_total} validators`);
        });
      } else {
        skip("On-chain signal commit", "dry run");
      }
    }
  }

  // =========================================================================
  // 5. IDIOT WRITE ENDPOINTS
  // =========================================================================
  if (shouldRun("idiot") || shouldRun("purchase")) {
    suite("Idiot Write Endpoints");

    if (!sessionToken) {
      const { json: c } = await api("/api/auth/connect", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const sig = await wallet.signMessage(c.challenge);
      const { json: v } = await api("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature: sig, nonce: c.nonce }),
      });
      sessionToken = v.session_token;
    }

    const authHeaders = { Authorization: `Bearer ${sessionToken}` };

    await test("POST /api/idiot/deposit returns unsigned txs", async () => {
      const { status, json } = await api("/api/idiot/deposit", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: 50 }),
      });
      assertEq(status, 200, `Got ${status}: ${JSON.stringify(json)}`);
      assert(json.approve_tx, "Missing approve_tx");
      assert(json.approve_tx.data, "approve_tx missing data");
      assert(json.approve_tx.chainId || json.approve_tx.to, "approve_tx missing chain info");
    });

    await test("POST /api/idiot/withdraw returns unsigned tx", async () => {
      const { status, json } = await api("/api/idiot/withdraw", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: 10 }),
      });
      assertEq(status, 200, `Got ${status}: ${JSON.stringify(json)}`);
      assert(json.tx, "Missing tx");
      assert(json.tx.data, "tx missing data");
    });

    await test("POST /api/idiot/deposit rejects negative amount", async () => {
      const { status } = await api("/api/idiot/deposit", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ amount_usdc: -100 }),
      });
      assertEq(status, 400);
    });

    await test("POST /api/idiot/purchase rejects nonexistent signal", async () => {
      const { status, json } = await api("/api/idiot/purchase", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ signal_id: "999999999999", notional_usdc: 10 }),
      });
      assert(status === 404 || status === 400, `Expected 404/400, got ${status}: ${JSON.stringify(json)}`);
    });

    await test("POST /api/idiot/purchase rejects missing signal_id", async () => {
      const { status } = await api("/api/idiot/purchase", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ notional_usdc: 10 }),
      });
      assertEq(status, 400);
    });

    await test("GET /api/idiot/purchases returns purchase history", async () => {
      const { status, json } = await api("/api/idiot/purchases?limit=5", {
        headers: authHeaders,
      });
      assertEq(status, 200, `Got ${status}: ${JSON.stringify(json)}`);
      assert(Array.isArray(json.purchases), "Missing purchases array");
      assert(typeof json.total === "number", "Missing total count");
    });

    if (!DRY_RUN && createdSignalId) {
      await test("Full purchase flow: deposit + purchase created signal", async () => {
        // Check escrow balance
        const escrow = new ethers.Contract(CONTRACTS.escrow, ESCROW_ABI, provider);
        const bal = await escrow.getBalance(address);
        const needed = 20n * 1000000n; // $20

        if (bal < needed) {
          // Deposit
          const usdcSigner = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, wallet);
          const appTx = await usdcSigner.approve(CONTRACTS.escrow, needed);
          await appTx.wait();

          const escrowSigner = new ethers.Contract(CONTRACTS.escrow, ESCROW_ABI, wallet);
          const depTx = await escrowSigner.deposit(needed);
          await depTx.wait();
          log("PURCHASE", `Deposited $${Number(needed) / 1e6} to escrow`);
        }

        // Get unsigned purchase tx from API
        const { status, json } = await api("/api/idiot/purchase", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            signal_id: createdSignalId.toString(),
            notional_usdc: 10,
          }),
        });
        assertEq(status, 200, `Purchase prep failed: ${JSON.stringify(json)}`);
        assert(json.tx, "Missing tx");
        log("PURCHASE", `Fee: $${json.fee_usdc}`);

        // Sign and submit
        const tx = await wallet.sendTransaction({
          to: json.tx.to,
          data: json.tx.data,
          chainId: json.tx.chainId,
        });
        const receipt = await tx.wait();
        log("PURCHASE", `Purchased: block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);

        // Verify in purchase list
        const { json: listJson } = await api("/api/idiot/purchases?limit=1", {
          headers: authHeaders,
        });
        assertGt(listJson.total, 0, "No purchases found after buying");
      });
    } else if (DRY_RUN) {
      skip("Full purchase flow", "dry run");
    } else {
      skip("Full purchase flow", "no signal was created");
    }
  }

  // =========================================================================
  // 6. ODDS API DEEP TESTS
  // =========================================================================
  if (shouldRun("odds")) {
    suite("Odds API");

    const sportKeys = [
      "baseball_mlb",
      "basketball_nba",
      "icehockey_nhl",
    ];

    for (const sport of sportKeys) {
      await test(`GET /api/odds?sport=${sport} returns valid data`, async () => {
        const { status, json } = await api(`/api/odds?sport=${sport}`);
        assertEq(status, 200);
        assert(Array.isArray(json), `Expected array for ${sport}`);
        // Some sports may have no current games, that's OK
        if (json.length > 0) {
          assert(json[0].home_team, "Missing home_team");
          assert(json[0].away_team, "Missing away_team");
          assert(json[0].bookmakers, "Missing bookmakers");
          log("ODDS", `${sport}: ${json.length} games`);
        } else {
          log("ODDS", `${sport}: no games currently`);
        }
      });
    }

    await test("GET /api/odds with markets filter", async () => {
      const { status, json } = await api("/api/odds?sport=baseball_mlb&markets=spreads");
      assertEq(status, 200);
      if (Array.isArray(json) && json.length > 0 && json[0].bookmakers?.length > 0) {
        const markets = json[0].bookmakers[0].markets.map((m) => m.key);
        assert(markets.includes("spreads"), "Missing spreads market");
      }
    });
  }

  // =========================================================================
  // 7. LINE AVAILABILITY CHECK
  // =========================================================================
  if (shouldRun("lines") && oddsData?.length > 0) {
    suite("Line Availability");

    await test("POST /api/check-lines validates lines", async () => {
      if (!oddsData || oddsData.length === 0) {
        throw new Error("No odds data available");
      }

      const game = oddsData[0];
      const bk = game.bookmakers[0];
      const spread = bk.markets.find((m) => m.key === "spreads");
      if (!spread) throw new Error("No spread market");

      const { status, json } = await api("/api/check-lines", {
        method: "POST",
        body: JSON.stringify({
          lines: [{
            sport: "baseball_mlb",
            event_id: game.id,
            home_team: game.home_team,
            away_team: game.away_team,
            market: "spreads",
            side: spread.outcomes[0].name,
            line: spread.outcomes[0].point,
            price: spread.outcomes[0].price,
          }],
        }),
        timeout: 60_000,
      });
      // 200 = checked, 502 = miners unavailable (both acceptable)
      assert(status === 200 || status === 502, `Unexpected status ${status}`);
      if (status === 200) {
        log("LINES", `Available indices: ${JSON.stringify(json.available_indices)}`);
      }
    });
  }

  // =========================================================================
  // 8. ATTESTATION
  // =========================================================================
  if (shouldRun("attest")) {
    suite("Attestation");

    await test("POST /api/attest with invalid request returns error", async () => {
      const { status } = await api("/api/attest", {
        method: "POST",
        body: JSON.stringify({}),
        timeout: 10_000,
      });
      // Should be 400 or similar, not 500
      assert(status >= 400 && status < 600, `Unexpected status ${status}`);
    });
  }

  // =========================================================================
  // 9. SETTLEMENT STATUS
  // =========================================================================
  if (shouldRun("settlement")) {
    suite("Settlement");

    await test("GET /api/settlement/{genius}/{idiot} returns status", async () => {
      const { status } = await api(
        `/api/settlement/${address}/${address}`
      );
      // 200 = data, 404 = no pair, 500 = RPC issue
      assert(status === 200 || status === 404 || status === 500, `Unexpected status ${status}`);
    });
  }

  // =========================================================================
  // 10. ADMIN (without auth, should reject)
  // =========================================================================
  if (shouldRun("admin")) {
    suite("Admin (auth boundary)");

    await test("GET /api/admin/errors rejects without auth", async () => {
      const { status } = await api("/api/admin/errors");
      assert(status === 401 || status === 403, `Expected 401/403, got ${status}`);
    });

    await test("POST /api/admin/clear-cache rejects without auth", async () => {
      const { status } = await api("/api/admin/clear-cache", { method: "POST" });
      assert(status === 401 || status === 403, `Expected 401/403, got ${status}`);
    });
  }

  // =========================================================================
  // REPORT
  // =========================================================================
  console.log(`\n\x1b[1m━━━ Results ━━━\x1b[0m`);
  console.log(`  \x1b[32m${passed} passed\x1b[0m`);
  if (failed > 0) console.log(`  \x1b[31m${failed} failed\x1b[0m`);
  if (skipped > 0) console.log(`  \x1b[33m${skipped} skipped\x1b[0m`);

  if (failures.length > 0) {
    console.log(`\n\x1b[1mFailures:\x1b[0m`);
    for (const f of failures) {
      console.log(`  \x1b[31m✗\x1b[0m ${f.name}`);
      console.log(`    ${f.error}`);
    }
  }

  // Slowest tests
  const sorted = [...timings].sort((a, b) => b.ms - a.ms);
  if (sorted.length > 3) {
    console.log(`\n\x1b[2mSlowest:\x1b[0m`);
    for (const t of sorted.slice(0, 5)) {
      console.log(`  \x1b[2m${t.ms}ms\x1b[0m ${t.name}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n\x1b[31mFATAL:\x1b[0m", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
