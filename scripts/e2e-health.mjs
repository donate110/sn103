#!/usr/bin/env node
/**
 * End-to-end health check for the full Djinn ecosystem.
 * Tests all services: djinn.gg, debust.com, proveaudit.com, firmrecord API,
 * validator, miners, attestation pipeline.
 *
 * Usage:
 *   node scripts/e2e-health.mjs              # quick health (no attestation)
 *   node scripts/e2e-health.mjs --full       # includes live attestation test (~2 min)
 *   node scripts/e2e-health.mjs --json       # output JSON for automation
 */

const VALIDATOR_URL = "http://37.60.251.252:8421";
const MINER_144_URL = "http://37.60.251.252:8422";
const MINER_21_URL = "http://161.97.138.250:8422";
const FIRMRECORD_API = "https://api.firmrecord.com";
const ADMIN_PASSWORD = "djinnybaby";

const fullMode = process.argv.includes("--full");
const jsonMode = process.argv.includes("--json");

const results = [];
let passed = 0;
let failed = 0;

function log(msg) {
  if (!jsonMode) console.log(msg);
}

async function check(name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    results.push({ name, status: "pass", ms, detail });
    passed++;
    log(`  \x1b[32mPASS\x1b[0m  ${name} (${ms}ms)${detail ? " - " + detail : ""}`);
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err.message || String(err);
    results.push({ name, status: "fail", ms, error: msg });
    failed++;
    log(`  \x1b[31mFAIL\x1b[0m  ${name} (${ms}ms) - ${msg}`);
  }
}

async function fetchJson(url, opts = {}) {
  const timeout = opts.timeout || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Validator ──
async function testValidator() {
  const d = await fetchJson(`${VALIDATOR_URL}/health`);
  if (d.status !== "ok") throw new Error(`status=${d.status}`);
  if (!d.attest_capable) throw new Error("not attest_capable");
  return `v${d.version} shares=${d.shares_held}`;
}

// ── Miners ──
async function testMiner(url, label) {
  const d = await fetchJson(`${url}/health`);
  if (d.status !== "ok") throw new Error(`status=${d.status}`);
  const pp = d.proactive_proof || {};
  const proofAge = Math.round(pp.proof_age_s || 99999);
  if (proofAge > 86400) throw new Error(`proactive proof stale (${proofAge}s)`);
  return `v${d.version} proof_age=${proofAge}s`;
}

// ── Websites ──
async function testWebsite(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 100) throw new Error(`response too short (${text.length} bytes)`);
    return `${res.status} (${text.length} bytes)`;
  } finally {
    clearTimeout(timer);
  }
}

// ── Odds API ──
async function testOdds() {
  const d = await fetchJson("https://www.djinn.gg/api/odds?sport=basketball_nba");
  if (!Array.isArray(d) || d.length === 0) throw new Error("no events returned");
  return `${d.length} NBA events`;
}

// ── FirmRecord API ──
async function testFirmRecord() {
  const d = await fetchJson(`${FIRMRECORD_API}/health`);
  if (d.status !== "ok") throw new Error(`status=${d.status}`);
  return `validators=${d.validators}`;
}

// ── Attestation success rate ──
async function testAttestationRate() {
  const d = await fetchJson(`${VALIDATOR_URL}/v1/metrics/attestations?password=${ADMIN_PASSWORD}`);
  const atts = d.attestations || [];
  const recent = atts.slice(0, 10);
  const ok = recent.filter(a => a.success).length;
  const rate = recent.length > 0 ? Math.round(100 * ok / recent.length) : 0;
  if (rate < 50) throw new Error(`only ${rate}% success (${ok}/${recent.length})`);
  return `${ok}/${recent.length} (${rate}%)`;
}

// ── Miner scores ──
async function testMinerScore(uid) {
  const d = await fetchJson(`${VALIDATOR_URL}/v1/miner/${uid}/scores`);
  if (!d.found) throw new Error("miner not found in scorer");
  const bd = d.weight_breakdown || {};
  return `weight=${d.weight.toFixed(5)} raw=${bd.raw_score.toFixed(3)} cov=${bd.coverage.toFixed(1)} att=${bd.attestations_total}/${bd.attestations_valid}`;
}

// ── Live attestation (slow, only in --full mode) ──
async function testLiveAttestation() {
  const body = JSON.stringify({ url: "https://httpbin.org/get", request_id: `health-${Date.now()}` });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const res = await fetch(`${VALIDATOR_URL}/v1/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const d = await res.json();
    if (!d.success) throw new Error(d.error || "attestation failed");
    if (!d.verified) throw new Error("proof not verified");
    const proofLen = (d.proof_hex || "").length;
    return `verified, ${proofLen} chars, server=${d.server_name}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main ──
async function main() {
  log("\n=== Djinn Ecosystem Health Check ===\n");
  log(`Mode: ${fullMode ? "FULL (includes live attestation)" : "QUICK"}\n`);

  log("Infrastructure:");
  await check("Validator health", testValidator);
  await check("Miner 144 health", () => testMiner(MINER_144_URL, "144"));
  await check("Miner 21 health", () => testMiner(MINER_21_URL, "21"));

  log("\nWebsites:");
  await check("djinn.gg", () => testWebsite("https://www.djinn.gg/", "djinn.gg"));
  await check("djinn.gg/attest", () => testWebsite("https://www.djinn.gg/attest", "attest"));
  await check("debust.com", () => testWebsite("https://debust.com/", "debust"));
  await check("proveaudit.com", () => testWebsite("https://proveaudit.com/", "proveaudit"));
  await check("firmrecord.com", () => testWebsite("https://firmrecord.com/", "firmrecord"));

  log("\nAPIs:");
  await check("FirmRecord API", testFirmRecord);
  await check("Odds API (NBA)", testOdds);
  await check("Attestation success rate", testAttestationRate);

  log("\nScoring:");
  await check("Miner 144 score", () => testMinerScore(144));
  await check("Miner 21 score", () => testMinerScore(21));

  if (fullMode) {
    log("\nLive attestation (this takes 1-3 minutes):");
    await check("Live attestation (validator direct)", testLiveAttestation);
  }

  log(`\n${"=".repeat(40)}`);
  log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${passed + failed} total`);
  if (failed > 0) log(`\x1b[31mSome checks failed!\x1b[0m`);
  else log(`\x1b[32mAll checks passed.\x1b[0m`);
  log("");

  if (jsonMode) {
    console.log(JSON.stringify({ passed, failed, total: passed + failed, results }, null, 2));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(2);
});
