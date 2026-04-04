#!/usr/bin/env node
/**
 * pre-upgrade-settle.mjs
 *
 * Settles ALL active genius-idiot cycles before a contract upgrade.
 *
 * Context: The protocol is migrating from cycle-based to queue-based audits.
 * Any unsettled cycles will have their collateral locks frozen after the
 * upgrade because the new code cannot read old cycle data. This script
 * force-settles every active pair so no funds are stranded.
 *
 * Strategy per pair:
 *   1. Record Void outcomes for any pending purchases (so outcomes are finalized)
 *   2. If signalCount >= 10 (audit-ready): call Audit.settle() (permissionless)
 *   3. If signalCount < 10 (early exit): call Audit.earlyExit() from a party
 *   4. earlyExit requires msg.sender == genius or idiot, so we try the deployer
 *      wallet first, then fall back to known test wallets from the .env
 *
 * Usage:
 *   node scripts/pre-upgrade-settle.mjs              # execute settlements
 *   node scripts/pre-upgrade-settle.mjs --dry-run    # report only, no txs
 *
 * Required env vars (or loaded from djinn/contracts/.env and web/.env):
 *   DEPLOYER_KEY   - private key for the deployer (authorized caller on Account/Escrow)
 *   BASE_RPC_URL   - RPC endpoint (falls back to https://sepolia.base.org)
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Env loader ─────────────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const env = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

const contractsEnv = loadEnv(resolve(ROOT, "djinn/contracts/.env"));
const webEnv = loadEnv(resolve(ROOT, "web/.env"));

const DRY_RUN = process.argv.includes("--dry-run");

// ── Config ─────────────────────────────────────────────────────────
const DEPLOYER_KEY = process.env.DEPLOYER_KEY || contractsEnv.DEPLOYER_KEY;
if (!DEPLOYER_KEY) {
  console.error("ERROR: DEPLOYER_KEY not set. Export it or add to djinn/contracts/.env");
  process.exit(1);
}

const RPC_URL =
  process.env.BASE_RPC_URL ||
  webEnv.BASE_RPC_URL ||
  webEnv.NEXT_PUBLIC_BASE_RPC_URL ||
  "https://sepolia.base.org";

const ADDRESSES = {
  account:          "0x4546354Dd32a613B76Abf530F81c8359e7cE440B",
  audit:            "0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E",
  escrow:           "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
  signalCommitment: "0x4712479Ba57c9ED40405607b2B18967B359209C0",
  collateral:       "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88",
  timelock:         "0x37f41EFfa8492022afF48B9Ef725008963F14f79",
};

// Outcome enum matching the Solidity contract
const Outcome = { Pending: 0, Favorable: 1, Unfavorable: 2, Void: 3 };
const OutcomeName = ["Pending", "Favorable", "Unfavorable", "Void"];

// ── ABIs (human-readable, ethers v6) ───────────────────────────────

const ACCOUNT_ABI = [
  "event PurchaseRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, uint256 signalCount)",
  "function activePairCount() view returns (uint256)",
  "function getAccountState(address genius, address idiot) view returns (tuple(uint256 currentCycle, uint256 signalCount, int256 outcomeBalance, uint256[] purchaseIds, bool settled))",
  "function isAuditReady(address genius, address idiot) view returns (bool)",
  "function getSignalCount(address genius, address idiot) view returns (uint256)",
  "function getCurrentCycle(address genius, address idiot) view returns (uint256)",
  "function getOutcome(address genius, address idiot, uint256 purchaseId) view returns (uint8)",
  "function getPurchaseIds(address genius, address idiot) view returns (uint256[])",
  "function recordOutcome(address genius, address idiot, uint256 purchaseId, uint8 outcome) external",
  "function authorizedCallers(address) view returns (bool)",
  "function setAuthorizedCaller(address caller, bool authorized) external",
  "function owner() view returns (address)",
];

const AUDIT_ABI = [
  "function settle(address genius, address idiot) external",
  "function earlyExit(address genius, address idiot) external",
  "function computeScore(address genius, address idiot) view returns (int256)",
  "function forceSettle(address genius, address idiot, int256 qualityScore) external",
  "function owner() view returns (address)",
];

const ESCROW_ABI = [
  "function setOutcome(uint256 purchaseId, uint8 outcome) external",
  "function getPurchase(uint256 purchaseId) view returns (tuple(address idiot, uint256 signalId, uint256 notional, uint256 feePaid, uint256 creditUsed, uint256 usdcPaid, uint256 odds, uint8 outcome, uint256 purchasedAt))",
  "function nextPurchaseId() view returns (uint256)",
  "function authorizedCallers(address) view returns (bool)",
  "function setAuthorizedCaller(address caller, bool _authorized) external",
  "function owner() view returns (address)",
];

const SIGNAL_ABI = [
  "function getSignal(uint256 signalId) view returns (tuple(address genius, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, uint8 status, uint256 createdAt))",
];

// ── Setup ──────────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

const accountContract = new ethers.Contract(ADDRESSES.account, ACCOUNT_ABI, wallet);
const auditContract = new ethers.Contract(ADDRESSES.audit, AUDIT_ABI, wallet);
const escrowContract = new ethers.Contract(ADDRESSES.escrow, ESCROW_ABI, wallet);
const signalContract = new ethers.Contract(ADDRESSES.signalCommitment, SIGNAL_ABI, provider);

// Collect known private keys for earlyExit (needs genius or idiot as msg.sender)
const knownWallets = new Map(); // address (lowercase) -> ethers.Wallet
knownWallets.set(wallet.address.toLowerCase(), wallet);

// Load E2E test wallet if available
const e2eKey = process.env.E2E_TEST_PRIVATE_KEY || webEnv.E2E_TEST_PRIVATE_KEY;
if (e2eKey) {
  try {
    const w = new ethers.Wallet(e2eKey, provider);
    knownWallets.set(w.address.toLowerCase(), w);
  } catch { /* ignore invalid key */ }
}

// Load genius G0 key if available
const g0Key = process.env.GENIUS_KEY || webEnv.GENIUS_PRIVATE_KEY || contractsEnv.GENIUS_KEY;
if (g0Key) {
  try {
    const w = new ethers.Wallet(g0Key, provider);
    knownWallets.set(w.address.toLowerCase(), w);
  } catch { /* ignore */ }
}

// ── Helpers ────────────────────────────────────────────────────────

function shortAddr(addr) {
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

async function ensureAuthorized() {
  // The deployer must be an authorized caller on Account and Escrow to record
  // Void outcomes for pending purchases.
  const acctAuth = await accountContract.authorizedCallers(wallet.address);
  const escrowAuth = await escrowContract.authorizedCallers(wallet.address);

  if (!acctAuth || !escrowAuth) {
    // Both contracts are owned by the TimelockController, and setAuthorizedCaller
    // is onlyOwner. However, the deployer wallet IS the proposer on the timelock,
    // and on testnet the deployer was typically pre-authorized. If not authorized,
    // we cannot proceed with outcome recording.
    console.log("");
    console.log(`  Account authorized: ${acctAuth}`);
    console.log(`  Escrow authorized:  ${escrowAuth}`);

    if (!acctAuth && !escrowAuth) {
      console.error("\nERROR: Deployer is not authorized on Account or Escrow.");
      console.error("Run 'node scripts/testnet-admin.mjs authorize' first, or");
      console.error("schedule setAuthorizedCaller via the TimelockController.");
      process.exit(1);
    }
    if (!acctAuth) {
      console.error("\nERROR: Deployer not authorized on Account. Run testnet-admin.mjs authorize.");
      process.exit(1);
    }
    if (!escrowAuth) {
      console.error("\nERROR: Deployer not authorized on Escrow. Run testnet-admin.mjs authorize.");
      process.exit(1);
    }
  }

  console.log("  Deployer authorized on Account and Escrow: OK");
}

// ── Step 1: Discover all active (genius, idiot) pairs ──────────────

async function discoverPairs() {
  console.log("\n[1/4] Discovering active genius-idiot pairs...\n");

  // Read on-chain activePairCount as a sanity check
  const activePairCount = await accountContract.activePairCount();
  console.log(`  Account.activePairCount() = ${activePairCount}`);

  if (Number(activePairCount) === 0) {
    console.log("  No active pairs on-chain. Nothing to settle.");
    return [];
  }

  // Scan PurchaseRecorded events from Account to find all (genius, idiot) pairs.
  // Account was deployed ~March 2026 on Base Sepolia. We scan from a reasonable
  // start block to avoid timeouts. Base Sepolia has ~2s blocks.
  const currentBlock = await provider.getBlockNumber();

  // Scan last ~500k blocks (roughly 12 days of Base Sepolia).
  // Adjust if the deployment is older.
  const START_BLOCK = Math.max(0, currentBlock - 500_000);
  const CHUNK_SIZE = 10_000;

  console.log(`  Scanning PurchaseRecorded events from block ${START_BLOCK} to ${currentBlock}...`);

  const pairsMap = new Map(); // "genius:idiot" -> { genius, idiot }

  for (let from = START_BLOCK; from <= currentBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, currentBlock);
    try {
      const events = await accountContract.queryFilter(
        accountContract.filters.PurchaseRecorded(),
        from,
        to,
      );
      for (const ev of events) {
        const genius = ev.args[0];
        const idiot = ev.args[1];
        const key = `${genius.toLowerCase()}:${idiot.toLowerCase()}`;
        if (!pairsMap.has(key)) {
          pairsMap.set(key, { genius, idiot });
        }
      }
    } catch (err) {
      // Some RPC providers limit range; try smaller chunks
      console.log(`    Warning: event query failed for blocks ${from}-${to}: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`  Found ${pairsMap.size} unique genius-idiot pairs from events.`);

  // Filter to only pairs that currently have active (unsettled) cycles with purchases
  const activePairs = [];
  for (const [key, pair] of pairsMap) {
    try {
      const state = await accountContract.getAccountState(pair.genius, pair.idiot);
      const signalCount = Number(state.signalCount);
      const purchaseIds = state.purchaseIds;

      // A pair is "active" if it has at least one purchase in its current cycle
      // and has not yet been settled
      if (purchaseIds.length > 0 && !state.settled) {
        activePairs.push({
          genius: pair.genius,
          idiot: pair.idiot,
          signalCount,
          currentCycle: Number(state.currentCycle),
          purchaseIds: purchaseIds.map((id) => Number(id)),
          settled: state.settled,
        });
      }
    } catch (err) {
      console.log(`    Warning: could not read state for ${key}: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`  Active (unsettled with purchases): ${activePairs.length} pairs`);
  return activePairs;
}

// ── Step 2: Finalize outcomes (record Void for any Pending) ────────

async function finalizeOutcomes(pairs) {
  console.log("\n[2/4] Finalizing outcomes (recording Void for pending purchases)...\n");

  let totalVoided = 0;
  let totalAlreadyFinalized = 0;

  for (const pair of pairs) {
    const label = `${shortAddr(pair.genius)} / ${shortAddr(pair.idiot)}`;

    for (const pid of pair.purchaseIds) {
      const outcome = Number(await accountContract.getOutcome(pair.genius, pair.idiot, pid));

      if (outcome !== Outcome.Pending) {
        totalAlreadyFinalized++;
        continue;
      }

      // This purchase needs a Void outcome recorded
      console.log(`  ${label} purchase #${pid}: Pending -> recording Void`);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would record Void on Escrow and Account`);
        totalVoided++;
        continue;
      }

      try {
        // Record on Escrow first (it syncs to Account internally if wired up,
        // but we also record on Account explicitly to be safe)
        const tx1 = await escrowContract.setOutcome(pid, Outcome.Void);
        console.log(`    Escrow.setOutcome tx: ${tx1.hash}`);
        await tx1.wait();
      } catch (err) {
        const msg = err.shortMessage || err.message || "";
        if (msg.includes("OutcomeAlreadySet")) {
          console.log(`    Escrow: already set (OK)`);
        } else {
          console.log(`    Escrow.setOutcome FAILED: ${msg.slice(0, 120)}`);
        }
      }

      try {
        // Record on Account (may already have been synced by Escrow.setOutcome,
        // but recording again is idempotent thanks to OutcomeAlreadyRecorded check)
        const tx2 = await accountContract.recordOutcome(
          pair.genius,
          pair.idiot,
          pid,
          Outcome.Void,
        );
        console.log(`    Account.recordOutcome tx: ${tx2.hash}`);
        await tx2.wait();
      } catch (err) {
        const msg = err.shortMessage || err.message || "";
        if (msg.includes("OutcomeAlreadyRecorded")) {
          console.log(`    Account: already recorded (OK, synced by Escrow)`);
        } else {
          console.log(`    Account.recordOutcome FAILED: ${msg.slice(0, 120)}`);
        }
      }

      totalVoided++;
    }
  }

  console.log(`\n  Outcomes voided: ${totalVoided}`);
  console.log(`  Already finalized: ${totalAlreadyFinalized}`);
  return totalVoided;
}

// ── Step 3: Verify all outcomes are finalized ──────────────────────

async function verifyOutcomes(pairs) {
  console.log("\n[3/4] Verifying all outcomes are finalized...\n");

  const ready = [];
  const blocked = [];

  for (const pair of pairs) {
    const label = `${shortAddr(pair.genius)} / ${shortAddr(pair.idiot)}`;
    let allFinalized = true;

    for (const pid of pair.purchaseIds) {
      const outcome = Number(await accountContract.getOutcome(pair.genius, pair.idiot, pid));
      if (outcome === Outcome.Pending) {
        allFinalized = false;
        console.log(`  BLOCKED: ${label} purchase #${pid} still Pending`);
      }
    }

    if (allFinalized) {
      ready.push(pair);
    } else {
      blocked.push(pair);
    }
  }

  console.log(`\n  Ready to settle: ${ready.length}`);
  if (blocked.length > 0) {
    console.log(`  BLOCKED (need manual outcome recording): ${blocked.length}`);
  }

  return { ready, blocked };
}

// ── Step 4: Settle each pair ───────────────────────────────────────

async function settlePairs(pairs) {
  console.log("\n[4/4] Settling pairs...\n");

  let settled = 0;
  let earlyExited = 0;
  let failed = 0;

  for (const pair of pairs) {
    const label = `${shortAddr(pair.genius)} / ${shortAddr(pair.idiot)}`;
    const isAuditReady = pair.signalCount >= 10;

    if (isAuditReady) {
      // Full settlement: Audit.settle() is permissionless
      console.log(`  ${label}: signalCount=${pair.signalCount}, cycle=${pair.currentCycle} -> settle()`);

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would call Audit.settle()`);
        settled++;
        continue;
      }

      try {
        const tx = await auditContract.settle(pair.genius, pair.idiot);
        console.log(`    tx: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`    Settled in block ${receipt.blockNumber}`);
        settled++;
      } catch (err) {
        const msg = err.shortMessage || err.message || "";
        if (msg.includes("AlreadySettled")) {
          console.log(`    Already settled (OK)`);
          settled++;
        } else {
          console.log(`    SETTLE FAILED: ${msg.slice(0, 200)}`);
          failed++;
        }
      }
    } else {
      // Early exit: Audit.earlyExit() requires msg.sender == genius or idiot
      console.log(`  ${label}: signalCount=${pair.signalCount}, cycle=${pair.currentCycle} -> earlyExit()`);

      // Find a wallet that is either the genius or the idiot
      const callerWallet =
        knownWallets.get(pair.genius.toLowerCase()) ||
        knownWallets.get(pair.idiot.toLowerCase());

      if (!callerWallet) {
        console.log(`    WARNING: No known wallet matches genius or idiot.`);
        console.log(`    Genius: ${pair.genius}`);
        console.log(`    Idiot:  ${pair.idiot}`);
        console.log(`    Known wallets: ${[...knownWallets.keys()].join(", ")}`);
        console.log(`    This pair needs forceSettle via TimelockController (72h delay).`);
        failed++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`    [DRY RUN] Would call Audit.earlyExit() as ${shortAddr(callerWallet.address)}`);
        earlyExited++;
        continue;
      }

      try {
        const auditForCaller = new ethers.Contract(ADDRESSES.audit, AUDIT_ABI, callerWallet);
        const tx = await auditForCaller.earlyExit(pair.genius, pair.idiot);
        console.log(`    tx: ${tx.hash} (called as ${shortAddr(callerWallet.address)})`);
        const receipt = await tx.wait();
        console.log(`    Early-exited in block ${receipt.blockNumber}`);
        earlyExited++;
      } catch (err) {
        const msg = err.shortMessage || err.message || "";
        if (msg.includes("AlreadySettled")) {
          console.log(`    Already settled (OK)`);
          earlyExited++;
        } else {
          console.log(`    EARLY EXIT FAILED: ${msg.slice(0, 200)}`);
          failed++;
        }
      }
    }
  }

  return { settled, earlyExited, failed };
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("==========================================================");
  console.log("  Djinn Pre-Upgrade Settlement Script");
  console.log("  Settles all active cycles before queue-based audit migration");
  if (DRY_RUN) {
    console.log("  MODE: DRY RUN (no transactions will be sent)");
  } else {
    console.log("  MODE: LIVE (transactions will be sent)");
  }
  console.log("==========================================================\n");

  console.log(`Deployer:  ${wallet.address}`);
  console.log(`RPC:       ${RPC_URL.replace(/\/v2\/.*/, "/v2/***")}`);
  console.log(`Account:   ${ADDRESSES.account}`);
  console.log(`Audit:     ${ADDRESSES.audit}`);
  console.log(`Escrow:    ${ADDRESSES.escrow}`);
  console.log(`Timelock:  ${ADDRESSES.timelock}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`ETH bal:   ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("\nERROR: Deployer has 0 ETH. Fund it before running this script.");
    process.exit(1);
  }

  // Verify deployer authorization (needed for outcome recording)
  if (!DRY_RUN) {
    await ensureAuthorized();
  } else {
    console.log("  [DRY RUN] Skipping authorization check");
  }

  // Step 1: discover pairs
  const pairs = await discoverPairs();
  if (pairs.length === 0) {
    console.log("\nNo active pairs to settle. Safe to proceed with upgrade.");
    process.exit(0);
  }

  // Print summary table
  console.log("\n  Pair Summary:");
  console.log("  " + "-".repeat(78));
  console.log(
    "  " +
      "Genius".padEnd(16) +
      "Idiot".padEnd(16) +
      "Cycle".padEnd(8) +
      "Signals".padEnd(10) +
      "Purchases".padEnd(12) +
      "Strategy",
  );
  console.log("  " + "-".repeat(78));
  for (const p of pairs) {
    const strategy = p.signalCount >= 10 ? "settle()" : "earlyExit()";
    console.log(
      "  " +
        shortAddr(p.genius).padEnd(16) +
        shortAddr(p.idiot).padEnd(16) +
        String(p.currentCycle).padEnd(8) +
        String(p.signalCount).padEnd(10) +
        String(p.purchaseIds.length).padEnd(12) +
        strategy,
    );
  }
  console.log("  " + "-".repeat(78));

  // Step 2: finalize outcomes
  await finalizeOutcomes(pairs);

  // Step 3: verify
  const { ready, blocked } = await verifyOutcomes(pairs);

  // Step 4: settle
  let results = { settled: 0, earlyExited: 0, failed: 0 };
  if (ready.length > 0) {
    results = await settlePairs(ready);
  }

  // ── Final report ─────────────────────────────────────────────────
  console.log("\n==========================================================");
  console.log("  SETTLEMENT REPORT");
  console.log("==========================================================");
  console.log(`  Total pairs discovered:           ${pairs.length}`);
  console.log(`  Settled (full audit):             ${results.settled}`);
  console.log(`  Settled (early exit):             ${results.earlyExited}`);
  console.log(`  Failed:                           ${results.failed}`);
  console.log(`  Blocked (need manual outcomes):   ${blocked.length}`);
  console.log("==========================================================");

  if (blocked.length > 0) {
    console.log("\nBLOCKED PAIRS (need manual intervention):");
    for (const p of blocked) {
      console.log(`  Genius: ${p.genius}`);
      console.log(`  Idiot:  ${p.idiot}`);
      console.log(`  Purchases with pending outcomes need to be resolved first.`);
      console.log("");
    }
  }

  if (results.failed > 0) {
    console.log("\nFAILED PAIRS (need manual intervention or forceSettle via TimelockController):");
    console.log("  Review the errors above. Common causes:");
    console.log("  - No known wallet matches genius or idiot (earlyExit requires a party)");
    console.log("  - Insufficient ETH for gas");
    console.log("  - Contract paused");
    console.log("");
  }

  const totalSettled = results.settled + results.earlyExited;
  const totalUnsettled = results.failed + blocked.length;

  if (totalUnsettled === 0 && totalSettled > 0) {
    console.log("\nAll pairs settled. Safe to proceed with the contract upgrade.");
  } else if (totalUnsettled === 0 && totalSettled === 0) {
    console.log("\nNo pairs needed settlement. Safe to proceed with the contract upgrade.");
  } else {
    console.log(`\nWARNING: ${totalUnsettled} pair(s) remain unsettled. DO NOT upgrade until resolved.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err.message || err);
  process.exit(1);
});
