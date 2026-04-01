#!/usr/bin/env node
/**
 * Djinn API Test Harness
 *
 * Full signal-creation-to-purchase loop using the REST API.
 * No browser required. Uses @djinn/sdk for client-side crypto,
 * ethers.js for on-chain transactions, and the API for coordination.
 *
 * Usage:
 *   node scripts/api-test-harness.mjs [--base-url https://djinn.gg] [--dry-run]
 *
 * Requires:
 *   E2E_TEST_PRIVATE_KEY  - wallet private key (genius + idiot for testing)
 *   NEXT_PUBLIC_BASE_RPC_URL - Base Sepolia RPC
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve ethers from the web project's node_modules
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
const DRY_RUN = args.includes("--dry-run");
const baseUrlFlag = args.find((a) => a.startsWith("--base-url="));
const baseUrlIdx = args.indexOf("--base-url");
const BASE_URL = baseUrlFlag
  ? baseUrlFlag.split("=")[1]
  : baseUrlIdx !== -1 && args[baseUrlIdx + 1]
    ? args[baseUrlIdx + 1]
    : "https://djinn.gg";

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY = process.env.E2E_TEST_PRIVATE_KEY;
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "84532");

// Contract addresses (Base Sepolia live deployment)
const SIGNAL_COMMITMENT = "0x4712479Ba57c9ED40405607b2B18967B359209C0";
const ESCROW = "0xb43BA175a6784973eB3825acF801Cd7920ac692a";
const USDC = "0x00e8293b05dbD3732EF3396ad1483E87e7265054";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${step}] ${msg}`);
}

async function api(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`API ${opts.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!PRIVATE_KEY) {
    console.error("Set E2E_TEST_PRIVATE_KEY environment variable");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const address = wallet.address;

  log("INIT", `Wallet: ${address}`);
  log("INIT", `RPC: ${RPC_URL}`);
  log("INIT", `API: ${BASE_URL}`);
  log("INIT", `Dry run: ${DRY_RUN}`);

  // Check balances
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(address);
  const ethBal = await provider.getBalance(address);
  log("INIT", `ETH balance: ${ethers.formatEther(ethBal)}`);
  log("INIT", `USDC balance: ${ethers.formatUnits(usdcBal, 6)}`);

  // -----------------------------------------------------------------------
  // Step 1: Authenticate
  // -----------------------------------------------------------------------
  log("AUTH", "Requesting challenge...");
  const connectRes = await api("/api/auth/connect", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  log("AUTH", `Got nonce: ${connectRes.nonce.slice(0, 16)}...`);

  log("AUTH", "Signing challenge...");
  const signature = await wallet.signMessage(connectRes.challenge);

  const verifyRes = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, signature, nonce: connectRes.nonce }),
  });
  const token = verifyRes.session_token;
  log("AUTH", `Session token: ${token.slice(0, 20)}... (expires ${verifyRes.expires_at})`);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // -----------------------------------------------------------------------
  // Step 2: Get network config (validators for Shamir)
  // -----------------------------------------------------------------------
  log("CONFIG", "Fetching network config...");
  const config = await api("/api/network/config");
  log("CONFIG", `${config.validators.length} validators, shamir k=${config.shamir_k}`);

  if (config.validators.length === 0) {
    log("ERROR", "No validators available. Cannot create signal.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 3: Create signal (client-side crypto + on-chain commit)
  // -----------------------------------------------------------------------
  log("SIGNAL", "Generating signal...");

  // Generate a random signal ID
  const signalIdBytes = new Uint8Array(32);
  crypto.getRandomValues(signalIdBytes);
  const signalId = BigInt("0x" + toHex(signalIdBytes));

  // Create a test pick
  const pick = {
    sport: "basketball_nba",
    event: "Lakers vs Celtics",
    market: "spread",
    team: "Lakers",
    line: -3.5,
    odds: -110,
    sportsbook: "DraftKings",
  };

  // Generate 9 decoy lines
  const decoys = Array.from({ length: 9 }, (_, i) => ({
    sport: "basketball_nba",
    event: "Lakers vs Celtics",
    market: "spread",
    team: i % 2 === 0 ? "Celtics" : "Lakers",
    line: -3.5 + (i - 4) * 0.5,
    odds: -110 + (i - 4) * 5,
    sportsbook: ["DraftKings", "FanDuel", "BetMGM"][i % 3],
  }));

  // Encrypt and split via SDK
  const validators = config.validators.map((v) => ({
    uid: v.uid,
    pubkey: v.hotkey || "",
  }));

  const encrypted = await encryptSignal({
    pick,
    decoys,
    validators,
    shamirK: config.shamir_k,
  });

  log("SIGNAL", `Encrypted blob: ${encrypted.blob.length} hex chars`);
  log("SIGNAL", `Commit hash: ${encrypted.hash.slice(0, 16)}...`);
  log("SIGNAL", `Real index: ${encrypted.realIndex} (1-indexed)`);
  log("SIGNAL", `Shares: ${encrypted.shares.length} validators`);

  if (DRY_RUN) {
    log("DRY", "Skipping on-chain commit and share distribution (dry run)");
    log("DRY", "Signal creation flow validated successfully");
    return;
  }

  // On-chain commit
  log("SIGNAL", "Committing signal on-chain...");
  const scContract = new ethers.Contract(SIGNAL_COMMITMENT, SIGNAL_COMMITMENT_ABI, wallet);
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 4 * 3600); // 4 hours

  const serializedLines = [...decoys, pick].map((l) =>
    `${l.sport}|${l.event}|${l.market}|${l.team}|${l.line}|${l.odds}|${l.sportsbook}`
  );

  const commitTx = await scContract.commit({
    signalId,
    encryptedBlob: "0x" + encrypted.blob,
    commitHash: "0x" + encrypted.hash,
    sport: "basketball_nba",
    maxPriceBps: 500n, // 5%
    slaMultiplierBps: 15000n, // 150%
    maxNotional: 100n * 1000000n, // $100 USDC
    minNotional: 1n * 1000000n, // $1 USDC
    expiresAt,
    decoyLines: serializedLines,
    availableSportsbooks: ["DraftKings"],
  });

  log("SIGNAL", `Commit tx: ${commitTx.hash}`);
  const receipt = await commitTx.wait();
  log("SIGNAL", `Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})`);

  // -----------------------------------------------------------------------
  // Step 4: Distribute shares via API
  // -----------------------------------------------------------------------
  log("SHARES", "Distributing Shamir shares via API...");
  const commitRes = await api("/api/genius/signal/commit", {
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
      event_id: `test-${Date.now()}`,
      sport: "basketball_nba",
      fee_bps: 500,
      sla_multiplier_bps: 15000,
      max_notional_usdc: 100,
      expires_at: new Date(Number(expiresAt) * 1000).toISOString(),
      shamir_threshold: config.shamir_k,
    }),
  });

  log("SHARES", `Received: ${commitRes.validators_received_shares}/${commitRes.validators_total}`);
  if (commitRes.validators_failed?.length > 0) {
    for (const f of commitRes.validators_failed) {
      log("SHARES", `  Failed UID ${f.uid}: ${f.reason}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Deposit USDC to escrow (if needed for purchase)
  // -----------------------------------------------------------------------
  const escrow = new ethers.Contract(ESCROW, ESCROW_ABI, provider);
  const escrowBal = await escrow.getBalance(address);
  log("ESCROW", `Current escrow balance: $${ethers.formatUnits(escrowBal, 6)}`);

  const purchaseNotional = 10; // $10
  const purchaseNotionalOnChain = BigInt(purchaseNotional * 1e6);

  if (escrowBal < purchaseNotionalOnChain) {
    const depositAmount = purchaseNotionalOnChain * 2n; // deposit double
    log("ESCROW", `Depositing $${ethers.formatUnits(depositAmount, 6)} USDC...`);

    // Approve USDC
    const usdcSigner = new ethers.Contract(USDC, ERC20_ABI, wallet);
    const approveTx = await usdcSigner.approve(ESCROW, depositAmount);
    await approveTx.wait();
    log("ESCROW", `USDC approved: ${approveTx.hash}`);

    // Deposit
    const escrowSigner = new ethers.Contract(ESCROW, ESCROW_ABI, wallet);
    const depositTx = await escrowSigner.deposit(depositAmount);
    await depositTx.wait();
    log("ESCROW", `Deposited: ${depositTx.hash}`);
  }

  // -----------------------------------------------------------------------
  // Step 6: Purchase signal via API
  // -----------------------------------------------------------------------
  log("PURCHASE", `Preparing purchase of signal ${signalId} for $${purchaseNotional}...`);
  const purchaseRes = await api("/api/idiot/purchase", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      signal_id: signalId.toString(),
      notional_usdc: purchaseNotional,
    }),
  });

  log("PURCHASE", `Fee: $${purchaseRes.fee_usdc}`);
  log("PURCHASE", `Unsigned tx to: ${purchaseRes.tx.to}`);

  // Sign and submit the purchase transaction
  log("PURCHASE", "Signing and submitting purchase tx...");
  const purchaseTx = await wallet.sendTransaction({
    to: purchaseRes.tx.to,
    data: purchaseRes.tx.data,
    chainId: purchaseRes.tx.chainId,
  });
  log("PURCHASE", `Purchase tx: ${purchaseTx.hash}`);
  const purchaseReceipt = await purchaseTx.wait();
  log("PURCHASE", `Confirmed in block ${purchaseReceipt.blockNumber} (gas: ${purchaseReceipt.gasUsed})`);

  // -----------------------------------------------------------------------
  // Step 7: Verify purchase via API
  // -----------------------------------------------------------------------
  log("VERIFY", "Checking purchases list...");
  const purchasesRes = await api(`/api/idiot/purchases?limit=5`, {
    headers: authHeaders,
  });
  log("VERIFY", `Total purchases: ${purchasesRes.total}`);
  if (purchasesRes.purchases?.length > 0) {
    const latest = purchasesRes.purchases[0];
    log("VERIFY", `Latest: signal=${latest.signal_id}, notional=$${latest.notional_usdc}, outcome=${latest.outcome}`);
  }

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------
  log("DONE", "Full signal-creation-to-purchase loop completed successfully!");
  log("DONE", `Signal ID: ${signalId}`);
  log("DONE", `Commit tx: ${commitTx.hash}`);
  log("DONE", `Purchase tx: ${purchaseTx.hash}`);
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
