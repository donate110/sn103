#!/usr/bin/env node
/**
 * Settlement Monitoring Script
 *
 * Monitors the Djinn settlement pipeline health:
 * - OutcomeVoting: pending votes, consensus health
 * - Validator wallet ETH balances on Base
 * - Recent settlement events (AuditSetSettled)
 * - Escrow and Collateral contract balances
 *
 * Usage:
 *   node scripts/settlement-monitor.mjs [--once]
 *   node scripts/settlement-monitor.mjs --telegram  # Send alerts to Telegram
 *
 * Environment:
 *   BASE_RPC_URL    - Base chain RPC (default: https://sepolia.base.org)
 *   TELEGRAM_TOKEN  - Telegram bot token for alerts
 *   TELEGRAM_CHAT   - Telegram chat ID for alerts
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ethers } = require("../web/node_modules/ethers");

const RPC_URL = process.env.BASE_RPC_URL || "https://sepolia.base.org";
const ONCE = process.argv.includes("--once");
const TELEGRAM = process.argv.includes("--telegram");
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Contract addresses (Base Sepolia)
const CONTRACTS = {
  escrow: "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
  collateral: "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88",
  outcomeVoting: "0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5",
  audit: "0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E",
  usdc: "0x00e8293b05dbD3732EF3396ad1483E87e7265054",
};

// Validator addresses on Base (derived from their private keys)
const VALIDATORS = [
  { name: "Yuma (UID 2)", address: "34.58.165.14" },
  { name: "Djinn (UID 41)", address: "37.60.251.252" },
  { name: "Kooltek68 (UID 189)", address: "161.97.150.248" },
  { name: "TAO.com (UID 213)", address: "3.150.72.96" },
];

const OUTCOME_VOTING_ABI = [
  "function getVoteCount(address genius, address idiot) view returns (uint256)",
  "function isFinalized(address genius, address idiot, uint256 cycle) view returns (bool)",
  "event VoteSubmitted(address indexed genius, address indexed idiot, address indexed validator, int256 qualityScore, uint256 totalNotional)",
];

const AUDIT_ABI = [
  "event AuditSetSettled(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 totalNotional, uint256 favorable, uint256 unfavorable, uint256 voidCount, uint256 timestamp)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

async function sendTelegram(message) {
  if (!TELEGRAM) return;
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT || "1530623518";
  if (!token) return;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: message, parse_mode: "Markdown" }),
    });
    if (!resp.ok) console.error("Telegram send failed:", resp.status);
  } catch (e) {
    console.error("Telegram error:", e.message);
  }
}

async function checkValidatorHealth() {
  const results = [];
  for (const v of VALIDATORS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(`http://${v.address}:8421/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json();
      results.push({
        ...v,
        online: true,
        version: data.version,
        shares: data.shares_held,
        chain: data.chain_connected,
        bt: data.bt_connected,
        attest: data.attest_capable,
      });
    } catch {
      results.push({ ...v, online: false });
    }
  }
  return results;
}

async function checkRecentSettlements(provider) {
  try {
    const audit = new ethers.Contract(CONTRACTS.audit, AUDIT_ABI, provider);
    const events = await audit.queryFilter(
      audit.filters.AuditSetSettled(),
      -50000,
    );
    return events.map((e) => {
      const args = e.args;
      return {
        genius: args.genius,
        idiot: args.idiot,
        cycle: Number(args.cycle),
        qualityScore: Number(args.qualityScore),
        favorable: Number(args.favorable),
        unfavorable: Number(args.unfavorable),
        void: Number(args.voidCount),
        block: e.blockNumber,
      };
    });
  } catch {
    return [];
  }
}

async function checkRecentVotes(provider) {
  try {
    const voting = new ethers.Contract(CONTRACTS.outcomeVoting, OUTCOME_VOTING_ABI, provider);
    const events = await voting.queryFilter(
      voting.filters.VoteSubmitted(),
      -50000,
    );
    return events.length;
  } catch {
    return 0;
  }
}

async function checkUsdcBalances(provider) {
  const usdc = new ethers.Contract(CONTRACTS.usdc, ERC20_ABI, provider);
  const results = {};
  for (const [name, addr] of Object.entries(CONTRACTS)) {
    if (name === "usdc") continue;
    try {
      const bal = await usdc.balanceOf(addr);
      results[name] = Number(bal) / 1e6;
    } catch {
      results[name] = "error";
    }
  }
  return results;
}

async function monitor() {
  const ts = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Settlement Monitor - ${ts}`);
  console.log(`${"=".repeat(60)}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const blockNumber = await provider.getBlockNumber();
  console.log(`\nBase block: ${blockNumber}`);

  // 1. Validator health
  console.log("\n--- Validator Health ---");
  const validators = await checkValidatorHealth();
  const online = validators.filter((v) => v.online);
  console.log(`Online: ${online.length}/${validators.length}`);
  for (const v of validators) {
    if (v.online) {
      console.log(`  [OK] ${v.name}: v${v.version}, ${v.shares} shares, chain=${v.chain}, bt=${v.bt}`);
    } else {
      console.log(`  [DOWN] ${v.name}`);
    }
  }

  if (online.length < 3) {
    const msg = `[ALERT] Only ${online.length}/${validators.length} validators online. MPC settlement requires 3+.`;
    console.log(msg);
    await sendTelegram(msg);
  }

  // 2. Recent settlements
  console.log("\n--- Recent Settlements ---");
  const settlements = await checkRecentSettlements(provider);
  console.log(`Total settlements found: ${settlements.length}`);
  for (const s of settlements.slice(-5)) {
    console.log(`  Cycle ${s.cycle}: score=${s.qualityScore}, fav=${s.favorable}, unfav=${s.unfavorable}, void=${s.void} (block ${s.block})`);
  }

  // 3. Recent votes
  console.log("\n--- Recent Votes ---");
  const voteCount = await checkRecentVotes(provider);
  console.log(`Votes in last 50k blocks: ${voteCount}`);

  // 4. Contract USDC balances
  console.log("\n--- Contract USDC Balances ---");
  const balances = await checkUsdcBalances(provider);
  for (const [name, bal] of Object.entries(balances)) {
    console.log(`  ${name}: $${typeof bal === "number" ? bal.toLocaleString() : bal}`);
  }

  // 5. Summary
  const status = online.length >= 3 ? "HEALTHY" : online.length >= 2 ? "DEGRADED" : "CRITICAL";
  console.log(`\n--- Status: ${status} ---`);

  if (TELEGRAM && (status !== "HEALTHY" || settlements.length === 0)) {
    await sendTelegram(
      `*Settlement Monitor*\n` +
      `Status: ${status}\n` +
      `Validators: ${online.length}/${validators.length}\n` +
      `Settlements: ${settlements.length}\n` +
      `Votes: ${voteCount}\n` +
      `Block: ${blockNumber}`,
    );
  }

  return status;
}

// Main
async function main() {
  if (ONCE) {
    await monitor();
    process.exit(0);
  }

  console.log("Settlement monitor starting (5-minute interval)...");
  await monitor();
  setInterval(monitor, INTERVAL_MS);
}

main().catch((e) => {
  console.error("Monitor error:", e);
  process.exit(1);
});
