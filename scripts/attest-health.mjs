#!/usr/bin/env node
/**
 * Attestation Health Monitor & Test Suite
 *
 * Evaluates the health of the SN103 attestation network by:
 *   1. Discovering validators/miners from metagraph
 *   2. Checking health + capacity on every node
 *   3. Pulling historical attestation data from validator admin APIs
 *   4. Running fresh attestation tests (sequential + concurrent)
 *   5. Producing a comprehensive report with bottleneck analysis
 *
 * Usage:
 *   node scripts/attest-health.mjs                  # full suite
 *   node scripts/attest-health.mjs --skip-tests     # telemetry only, no live tests
 *   node scripts/attest-health.mjs --tests-only     # skip telemetry, run live tests
 *   node scripts/attest-health.mjs --concurrency 5  # concurrent test count (default 3)
 */

const DJINN_API = "https://www.djinn.gg/api/attest";
const KNOWN_VALIDATORS = [
  { uid: 41, url: "http://89.167.106.53:8421", label: "ours" },
  { uid: 2, url: "http://34.58.165.14:8421", label: "yuma" },
  { uid: 189, url: "http://161.97.150.248:8421", label: "kooltek68" },
  { uid: 213, url: "http://3.150.72.96:8421", label: "uid213" },
  { uid: 1, url: "http://167.150.153.103:8421", label: "uid1" },
];
const KNOWN_MINERS = [
  { uid: 8, url: "http://103.219.170.225:12002", label: "uid8-v726" },
  { uid: 234, url: "http://206.223.238.52:12008", label: "uid234-v726" },
];

// URLs to test attestation against (mix of easy, medium, edge cases)
const TEST_URLS = [
  { url: "https://httpbin.org/get", label: "httpbin (small JSON)", expect: "easy" },
  { url: "https://api.github.com/zen", label: "github zen (tiny)", expect: "easy" },
  { url: "https://jsonplaceholder.typicode.com/posts/1", label: "jsonplaceholder (small)", expect: "easy" },
  { url: "https://www.wikipedia.org/", label: "wikipedia (medium HTML)", expect: "easy" },
];

const CONCURRENT_URLS = [
  "https://httpbin.org/get",
  "https://api.github.com/zen",
  "https://www.wikipedia.org/",
];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const args = process.argv.slice(2);
const SKIP_TESTS = args.includes("--skip-tests");
const TESTS_ONLY = args.includes("--tests-only");
const CONCURRENCY = (() => {
  const idx = args.indexOf("--concurrency");
  return idx >= 0 ? parseInt(args[idx + 1], 10) || 3 : 3;
})();

const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
const hr = () => console.log("─".repeat(80));

async function fetchJson(url, opts = {}) {
  const timeout = opts.timeout || 10_000;
  try {
    const res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

async function postJson(url, body, opts = {}) {
  const timeout = opts.timeout || 180_000;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  }
}

function stats(arr) {
  if (!arr.length) return { min: 0, max: 0, avg: 0, median: 0, p95: 0, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: +(sum / sorted.length).toFixed(1),
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    count: sorted.length,
  };
}

// ─────────────────────────────────────────────
// Phase 1: Node Health & Discovery
// ─────────────────────────────────────────────

async function checkNodeHealth(node) {
  const start = Date.now();
  const res = await fetchJson(`${node.url}/health`, { timeout: 5_000 });
  const elapsed = Date.now() - start;

  if (!res.ok || !res.data) {
    return { ...node, reachable: false, elapsed, error: res.error || `HTTP ${res.status}` };
  }

  const d = res.data;
  return {
    ...node,
    reachable: true,
    elapsed,
    version: d.version || d.release || "unknown",
    status: d.status,
    bt_connected: d.bt_connected,
    chain_connected: d.chain_connected,
    attest_capable: d.attest_capable,
    shares_held: d.shares_held,
    pending_outcomes: d.pending_outcomes,
    // Miner-specific
    odds_api_connected: d.odds_api_connected,
    tlsn_binary: d.tlsn_binary,
    notary_enabled: d.notary_enabled,
    notary_pubkey: d.notary_pubkey ? d.notary_pubkey.slice(0, 16) + "..." : undefined,
    tlsn_active: d.tlsn_active_sessions,
    tlsn_max: d.tlsn_max_concurrent,
    notary_active: d.notary_active_sessions,
    notary_max: d.notary_max_concurrent,
  };
}

async function checkAttestCapacity(node) {
  const res = await fetchJson(`${node.url}/v1/attest/capacity`, { timeout: 5_000 });
  if (!res.ok || !res.data) return null;
  return { uid: node.uid, ...res.data };
}

async function discoverMetagraph() {
  // Try the djinn.gg metagraph debug endpoint
  const res = await fetchJson("https://www.djinn.gg/api/debug/metagraph", { timeout: 15_000 });
  if (res.ok && res.data) return res.data;
  return null;
}

async function phaseNodeHealth() {
  console.log("\n");
  hr();
  log("HEALTH", "Phase 1: Node Health & Discovery");
  hr();

  // Check known validators
  log("HEALTH", "Checking known validators...");
  const valResults = await Promise.all(KNOWN_VALIDATORS.map(checkNodeHealth));
  const valCapacity = await Promise.all(
    KNOWN_VALIDATORS.filter((v) => valResults.find((r) => r.uid === v.uid && r.reachable))
      .map(checkAttestCapacity)
  );

  for (const v of valResults) {
    if (v.reachable) {
      const cap = valCapacity.find((c) => c && c.uid === v.uid);
      log("HEALTH", `  Validator UID ${v.uid} (${v.label}): ${v.version}, ` +
        `attest=${v.attest_capable ? "YES" : "NO"}, ` +
        `bt=${v.bt_connected}, chain=${v.chain_connected}, ` +
        `shares=${v.shares_held}, pending=${v.pending_outcomes}, ` +
        `ping=${v.elapsed}ms` +
        (cap ? `, capacity=${cap.available}/${cap.max} (${cap.inflight} inflight)` : ""));
    } else {
      log("HEALTH", `  Validator UID ${v.uid} (${v.label}): UNREACHABLE (${v.error}), ${v.elapsed}ms`);
    }
  }

  // Check known miners
  log("HEALTH", "Checking known miners...");
  const minerResults = await Promise.all(KNOWN_MINERS.map(checkNodeHealth));

  for (const m of minerResults) {
    if (m.reachable) {
      log("HEALTH", `  Miner UID ${m.uid} (${m.label}): ${m.version}, ` +
        `tlsn=${m.tlsn_binary ? "YES" : "NO"}, ` +
        `notary=${m.notary_enabled ? "YES" : "NO"}, ` +
        `odds=${m.odds_api_connected}, ` +
        `prover_sessions=${m.tlsn_active}/${m.tlsn_max}, ` +
        `notary_sessions=${m.notary_active}/${m.notary_max}, ` +
        `ping=${m.elapsed}ms`);
    } else {
      log("HEALTH", `  Miner UID ${m.uid} (${m.label}): UNREACHABLE (${m.error}), ${m.elapsed}ms`);
    }
  }

  // Try metagraph discovery
  log("HEALTH", "Checking metagraph discovery...");
  const meta = await discoverMetagraph();
  if (meta) {
    log("HEALTH", `  Metagraph: ${JSON.stringify({
      validators: meta.validators?.length ?? "?",
      miners: meta.miners?.length ?? "?",
      attest_capable: meta.attest_capable?.length ?? "?",
      discovery_ms: meta.discovery_ms ?? "?",
    })}`);
  } else {
    log("HEALTH", "  Metagraph discovery failed or unavailable");
  }

  return { validators: valResults, miners: minerResults, metagraph: meta };
}

// ─────────────────────────────────────────────
// Phase 2: Historical Telemetry
// ─────────────────────────────────────────────

async function fetchAdminAttestations(validatorUrl, limit = 100) {
  const res = await fetchJson(`${validatorUrl}/v1/metrics/attestations?limit=${limit}`, { timeout: 10_000 });
  if (!res.ok) return null;
  return res.data;
}

async function fetchTimeseries(validatorUrl, hours = 168, bucket = 3600) {
  const res = await fetchJson(
    `${validatorUrl}/v1/metrics/timeseries?hours=${hours}&bucket=${bucket}`,
    { timeout: 10_000 },
  );
  if (!res.ok) return null;
  return res.data;
}

async function fetchMinerScores(validatorUrl, uid) {
  const res = await fetchJson(`${validatorUrl}/v1/miner/${uid}/scores`, { timeout: 5_000 });
  if (!res.ok) return null;
  return res.data;
}

async function phaseTelemetry(validators) {
  console.log("\n");
  hr();
  log("TELEMETRY", "Phase 2: Historical Attestation Data");
  hr();

  const reachable = validators.filter((v) => v.reachable && v.attest_capable);
  if (!reachable.length) {
    log("TELEMETRY", "No reachable attest-capable validators, skipping telemetry");
    return { attestations: [], timeseries: null, minerScores: [] };
  }

  const primaryVal = reachable[0];
  log("TELEMETRY", `Using validator UID ${primaryVal.uid} (${primaryVal.label}) for admin data`);

  // Fetch recent attestations
  const attestations = await fetchAdminAttestations(primaryVal.url, 200);
  if (attestations && Array.isArray(attestations)) {
    log("TELEMETRY", `  Retrieved ${attestations.length} recent attestation records`);

    // Analyze
    const total = attestations.length;
    const successful = attestations.filter((a) => a.success).length;
    const verified = attestations.filter((a) => a.verified).length;
    const errored = attestations.filter((a) => !a.success).length;
    const latencies = attestations.filter((a) => a.elapsed_s > 0).map((a) => a.elapsed_s);
    const latStats = stats(latencies);

    // Miner distribution
    const minerCounts = {};
    const notaryCounts = {};
    for (const a of attestations) {
      if (a.miner_uid != null) minerCounts[a.miner_uid] = (minerCounts[a.miner_uid] || 0) + 1;
      if (a.notary_uid != null) notaryCounts[a.notary_uid] = (notaryCounts[a.notary_uid] || 0) + 1;
    }

    // Error distribution
    const errorTypes = {};
    for (const a of attestations.filter((a) => !a.success && a.error)) {
      const key = a.error.slice(0, 80);
      errorTypes[key] = (errorTypes[key] || 0) + 1;
    }

    // URL distribution
    const urlCounts = {};
    for (const a of attestations) {
      const host = a.url ? new URL(a.url).hostname : "unknown";
      urlCounts[host] = (urlCounts[host] || 0) + 1;
    }

    // Time range
    const timestamps = attestations.map((a) => a.created_at).filter(Boolean).sort();
    const oldest = timestamps[0] ? new Date(timestamps[0] * 1000).toISOString() : "?";
    const newest = timestamps[timestamps.length - 1] ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString() : "?";
    const spanHours = timestamps.length >= 2
      ? ((timestamps[timestamps.length - 1] - timestamps[0]) / 3600).toFixed(1)
      : "?";

    log("TELEMETRY", `\n  ── Attestation Summary (last ${total} records, ${spanHours}h span) ──`);
    log("TELEMETRY", `  Time range: ${oldest} to ${newest}`);
    log("TELEMETRY", `  Success rate: ${successful}/${total} (${((successful / total) * 100).toFixed(1)}%)`);
    log("TELEMETRY", `  Verification rate: ${verified}/${successful} successful verified (${successful > 0 ? ((verified / successful) * 100).toFixed(1) : 0}%)`);
    log("TELEMETRY", `  Error rate: ${errored}/${total} (${((errored / total) * 100).toFixed(1)}%)`);
    log("TELEMETRY", `  Latency: min=${latStats.min}s, avg=${latStats.avg}s, median=${latStats.median}s, p95=${latStats.p95}s, max=${latStats.max}s`);
    log("TELEMETRY", `  Miner distribution: ${JSON.stringify(minerCounts)}`);
    log("TELEMETRY", `  Notary distribution: ${JSON.stringify(notaryCounts)}`);
    log("TELEMETRY", `  URL distribution: ${JSON.stringify(urlCounts)}`);
    if (Object.keys(errorTypes).length > 0) {
      log("TELEMETRY", `  Error types:`);
      for (const [err, count] of Object.entries(errorTypes).sort((a, b) => b[1] - a[1])) {
        log("TELEMETRY", `    ${count}x: ${err}`);
      }
    }
  } else {
    log("TELEMETRY", "  Could not fetch attestation records (admin endpoint may require auth)");
  }

  // Fetch timeseries (last 7 days, hourly buckets)
  const timeseries = await fetchTimeseries(primaryVal.url, 168, 3600);
  if (timeseries && timeseries.attestations) {
    const atBuckets = timeseries.attestations.filter((b) => b.total > 0);
    if (atBuckets.length > 0) {
      const totalReqs = atBuckets.reduce((s, b) => s + b.total, 0);
      const totalSuccess = atBuckets.reduce((s, b) => s + b.success, 0);
      const totalVerified = atBuckets.reduce((s, b) => s + b.verified, 0);
      const totalErrors = atBuckets.reduce((s, b) => s + b.errors, 0);
      const avgLat = atBuckets.reduce((s, b) => s + (b.avg_latency || 0) * b.total, 0) / totalReqs;

      log("TELEMETRY", `\n  ── 7-Day Timeseries (${atBuckets.length} active hours) ──`);
      log("TELEMETRY", `  Total requests: ${totalReqs}`);
      log("TELEMETRY", `  Success: ${totalSuccess} (${((totalSuccess / totalReqs) * 100).toFixed(1)}%)`);
      log("TELEMETRY", `  Verified: ${totalVerified} (${((totalVerified / totalReqs) * 100).toFixed(1)}%)`);
      log("TELEMETRY", `  Errors: ${totalErrors}`);
      log("TELEMETRY", `  Avg latency: ${avgLat.toFixed(1)}s`);
      log("TELEMETRY", `  Avg requests/hour: ${(totalReqs / atBuckets.length).toFixed(1)}`);

      // Peak hour
      const peak = atBuckets.reduce((best, b) => b.total > best.total ? b : best, atBuckets[0]);
      log("TELEMETRY", `  Peak hour: ${new Date(peak.t * 1000).toISOString()} with ${peak.total} requests`);

      // Recent trend (last 24h vs prior 24h)
      const now = Date.now() / 1000;
      const last24 = atBuckets.filter((b) => b.t > now - 86400);
      const prior24 = atBuckets.filter((b) => b.t > now - 172800 && b.t <= now - 86400);
      if (last24.length > 0 && prior24.length > 0) {
        const recent = last24.reduce((s, b) => s + b.total, 0);
        const prior = prior24.reduce((s, b) => s + b.total, 0);
        const change = prior > 0 ? (((recent - prior) / prior) * 100).toFixed(0) : "N/A";
        log("TELEMETRY", `  24h trend: ${recent} requests (vs ${prior} prior 24h, ${change}% change)`);
      }
    } else {
      log("TELEMETRY", "  No attestation activity in timeseries");
    }
  } else {
    log("TELEMETRY", "  Could not fetch timeseries data");
  }

  // Fetch miner scores
  const minerScores = [];
  // Get all UIDs from attestation records + known miners
  const attArr = Array.isArray(attestations) ? attestations : [];
  const minerUids = new Set([
    ...KNOWN_MINERS.map((m) => m.uid),
    ...attArr.map((a) => a.miner_uid).filter(Boolean),
  ]);

  if (minerUids.size > 0) {
    log("TELEMETRY", `\n  ── Miner Scores (${minerUids.size} miners) ──`);
    const scorePromises = [...minerUids].map(async (uid) => {
      const scores = await fetchMinerScores(primaryVal.url, uid);
      return { uid, scores };
    });
    const scoreResults = await Promise.all(scorePromises);
    for (const { uid, scores } of scoreResults) {
      if (scores && scores.found) {
        minerScores.push({ uid, ...scores });
        log("TELEMETRY", `  UID ${uid}: ` +
          `attest_valid=${scores.attestations_valid}/${scores.attestations_total}, ` +
          `accuracy=${scores.accuracy?.toFixed(2) ?? "?"}, ` +
          `uptime=${scores.uptime?.toFixed(2) ?? "?"}, ` +
          `notary_reliability=${scores.notary_reliability?.toFixed(2) ?? "?"}, ` +
          `notary_duties=${scores.notary_duties_completed}/${scores.notary_duties_assigned}`);
      } else {
        log("TELEMETRY", `  UID ${uid}: not found in scorer`);
      }
    }
  }

  return { attestations, timeseries, minerScores };
}

// ─────────────────────────────────────────────
// Phase 3: Live Attestation Tests
// ─────────────────────────────────────────────

async function runSingleAttest(url, label, requestId) {
  const id = requestId || `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const start = Date.now();
  const res = await postJson(DJINN_API, { url, request_id: id }, { timeout: 300_000 });
  const elapsed = (Date.now() - start) / 1000;

  if (res.status === 429) {
    return { url, label, elapsed, success: false, rateLimited: true, error: "Rate limited (429)" };
  }

  if (!res.ok || !res.data) {
    return { url, label, elapsed, success: false, error: res.error || res.data?.error || `HTTP ${res.status}` };
  }

  const d = res.data;
  return {
    url,
    label,
    elapsed: +elapsed.toFixed(1),
    success: d.success,
    verified: d.verified,
    verifiedBy: d.verifiedBy,
    blocked: d.blocked,
    server_name: d.server_name,
    proofSize: d.proof_hex ? Math.floor(d.proof_hex.length / 2) : 0,
    timestamp: d.timestamp,
    error: d.error || null,
    miner_uid: d.miner_uid,
    busy: d.busy,
  };
}

async function phaseTests() {
  console.log("\n");
  hr();
  log("TESTS", "Phase 3: Live Attestation Tests");
  hr();

  const allResults = [];

  // 3a: Sequential tests (one at a time, with delay to avoid rate limit)
  log("TESTS", `Running ${TEST_URLS.length} sequential attestation tests...`);
  for (let i = 0; i < TEST_URLS.length; i++) {
    const { url, label } = TEST_URLS[i];
    log("TESTS", `  [${i + 1}/${TEST_URLS.length}] ${label}...`);
    const result = await runSingleAttest(url, label);
    allResults.push({ ...result, mode: "sequential" });

    if (result.success) {
      log("TESTS", `    OK in ${result.elapsed}s, verified=${result.verified}, ` +
        `proof=${result.proofSize} bytes, server=${result.server_name}`);
    } else if (result.rateLimited) {
      log("TESTS", `    RATE LIMITED (waiting 60s before continuing...)`);
      await new Promise((r) => setTimeout(r, 60_000));
    } else {
      log("TESTS", `    FAILED in ${result.elapsed}s: ${result.error}`);
    }

    // Delay between sequential tests to stay under rate limit (5/min)
    if (i < TEST_URLS.length - 1) {
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  // 3b: Concurrent test batch
  log("TESTS", `\n  Running ${CONCURRENCY} concurrent attestation tests...`);
  const concUrls = CONCURRENT_URLS.slice(0, CONCURRENCY);
  const concStart = Date.now();

  // Wait for rate limit to reset before concurrent test
  log("TESTS", "  (waiting 60s for rate limit reset...)");
  await new Promise((r) => setTimeout(r, 60_000));

  const concPromises = concUrls.map((url, i) =>
    runSingleAttest(url, `concurrent-${i}`, `conc-${Date.now()}-${i}`)
  );
  const concResults = await Promise.all(concPromises);
  const concElapsed = ((Date.now() - concStart) / 1000).toFixed(1);

  let concOk = 0, concBusy = 0, concRL = 0, concFail = 0;
  for (const r of concResults) {
    allResults.push({ ...r, mode: "concurrent" });
    if (r.success) concOk++;
    else if (r.rateLimited) concRL++;
    else if (r.busy) concBusy++;
    else concFail++;

    log("TESTS", `    ${r.label}: ${r.success ? "OK" : "FAIL"} in ${r.elapsed}s` +
      (r.success ? `, verified=${r.verified}, proof=${r.proofSize}b` : `, error=${r.error}`));
  }
  log("TESTS", `  Concurrent batch: ${concElapsed}s total, ` +
    `ok=${concOk}, busy=${concBusy}, rateLimit=${concRL}, fail=${concFail}`);

  return allResults;
}

// ─────────────────────────────────────────────
// Phase 4: Analysis & Report
// ─────────────────────────────────────────────

function phaseReport(health, telemetry, testResults) {
  console.log("\n");
  hr();
  console.log("  ATTESTATION HEALTH REPORT");
  hr();

  const { validators, miners, metagraph } = health;
  const { attestations, timeseries, minerScores } = telemetry || {};

  // ── Network Status ──
  console.log("\n  NETWORK STATUS");
  const reachableVals = validators.filter((v) => v.reachable);
  const attestVals = reachableVals.filter((v) => v.attest_capable);
  const reachableMiners = miners.filter((m) => m.reachable);
  const tlsnMiners = reachableMiners.filter((m) => m.tlsn_binary);
  const notaryMiners = reachableMiners.filter((m) => m.notary_enabled);

  console.log(`    Validators: ${reachableVals.length}/${validators.length} reachable, ${attestVals.length} attest-capable`);
  console.log(`    Miners: ${reachableMiners.length}/${miners.length} reachable, ${tlsnMiners.length} have TLSNotary, ${notaryMiners.length} run notary`);

  const versions = {};
  for (const n of [...reachableVals, ...reachableMiners]) {
    versions[n.version] = (versions[n.version] || 0) + 1;
  }
  console.log(`    Versions: ${JSON.stringify(versions)}`);

  // ── Historical Performance ──
  if (attestations && Array.isArray(attestations) && attestations.length > 0) {
    console.log("\n  HISTORICAL PERFORMANCE");
    const total = attestations.length;
    const ok = attestations.filter((a) => a.success).length;
    const ver = attestations.filter((a) => a.verified).length;
    const lats = attestations.filter((a) => a.elapsed_s > 0).map((a) => a.elapsed_s);
    const ls = stats(lats);

    console.log(`    Records: ${total} (from admin endpoint)`);
    console.log(`    Success rate: ${((ok / total) * 100).toFixed(1)}%`);
    console.log(`    Verification rate: ${ok > 0 ? ((ver / ok) * 100).toFixed(1) : 0}% of successes`);
    console.log(`    Latency: avg=${ls.avg}s, median=${ls.median}s, p95=${ls.p95}s, max=${ls.max}s`);
  }

  // ── Live Test Results ──
  if (testResults && testResults.length > 0) {
    console.log("\n  LIVE TEST RESULTS");
    const seqTests = testResults.filter((r) => r.mode === "sequential");
    const conTests = testResults.filter((r) => r.mode === "concurrent");

    const seqOk = seqTests.filter((r) => r.success);
    const conOk = conTests.filter((r) => r.success);
    const seqLats = seqOk.map((r) => r.elapsed);
    const conLats = conOk.map((r) => r.elapsed);
    const seqStats = stats(seqLats);
    const conStats = stats(conLats);

    console.log(`    Sequential: ${seqOk.length}/${seqTests.length} succeeded`);
    if (seqLats.length > 0) {
      console.log(`      Latency: avg=${seqStats.avg}s, median=${seqStats.median}s, min=${seqStats.min}s, max=${seqStats.max}s`);
    }
    const seqVerified = seqOk.filter((r) => r.verified).length;
    console.log(`      Verified: ${seqVerified}/${seqOk.length}`);

    console.log(`    Concurrent (${conTests.length} simultaneous): ${conOk.length}/${conTests.length} succeeded`);
    if (conLats.length > 0) {
      console.log(`      Latency: avg=${conStats.avg}s, median=${conStats.median}s, min=${conStats.min}s, max=${conStats.max}s`);
    }
    const conVerified = conOk.filter((r) => r.verified).length;
    console.log(`      Verified: ${conVerified}/${conOk.length}`);

    // Proof sizes
    const proofSizes = testResults.filter((r) => r.proofSize > 0).map((r) => r.proofSize);
    if (proofSizes.length > 0) {
      const ps = stats(proofSizes);
      console.log(`    Proof sizes: avg=${ps.avg} bytes, min=${ps.min}, max=${ps.max}`);
    }
  }

  // ── Bottleneck Analysis ──
  console.log("\n  BOTTLENECK ANALYSIS");
  const issues = [];
  const suggestions = [];

  // Check validator availability
  const unreachableVals = validators.filter((v) => !v.reachable);
  if (unreachableVals.length > 0) {
    issues.push(`${unreachableVals.length} validators unreachable: UIDs ${unreachableVals.map((v) => v.uid).join(", ")}`);
  }

  const nonAttestVals = reachableVals.filter((v) => !v.attest_capable);
  if (nonAttestVals.length > 0) {
    issues.push(`${nonAttestVals.length} validators not attest-capable (missing verifier binary?): UIDs ${nonAttestVals.map((v) => v.uid).join(", ")}`);
  }

  // Check miner capacity
  for (const m of reachableMiners) {
    if (m.tlsn_active != null && m.tlsn_max != null && m.tlsn_active >= m.tlsn_max) {
      issues.push(`Miner UID ${m.uid} at max prover capacity (${m.tlsn_active}/${m.tlsn_max})`);
    }
    if (m.notary_active != null && m.notary_max != null && m.notary_active >= m.notary_max) {
      issues.push(`Miner UID ${m.uid} at max notary capacity (${m.notary_active}/${m.notary_max})`);
    }
    if (!m.tlsn_binary) {
      issues.push(`Miner UID ${m.uid} missing TLSNotary binary`);
    }
    if (!m.notary_enabled) {
      issues.push(`Miner UID ${m.uid} notary sidecar disabled`);
    }
  }

  // Check historical error patterns
  if (attestations && Array.isArray(attestations)) {
    const errorRate = attestations.filter((a) => !a.success).length / attestations.length;
    if (errorRate > 0.2) {
      issues.push(`High error rate: ${(errorRate * 100).toFixed(1)}% of recent attestations failed`);
    }
    const verRate = attestations.filter((a) => a.success).length > 0
      ? attestations.filter((a) => a.verified).length / attestations.filter((a) => a.success).length
      : 0;
    if (verRate < 0.8 && attestations.filter((a) => a.success).length > 5) {
      issues.push(`Low verification rate: only ${(verRate * 100).toFixed(1)}% of successful attestations were verified`);
    }

    // Latency issues
    const lats = attestations.filter((a) => a.elapsed_s > 0).map((a) => a.elapsed_s);
    const avgLat = lats.length > 0 ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
    if (avgLat > 60) {
      issues.push(`High average latency: ${avgLat.toFixed(1)}s (target <60s)`);
      suggestions.push("Consider increasing ATTEST_MAX_CONCURRENT on miners or adding more miners");
    }
  }

  // Test-based issues
  if (testResults) {
    const rateLimited = testResults.filter((r) => r.rateLimited).length;
    if (rateLimited > 0) {
      issues.push(`${rateLimited} test requests were rate limited`);
      suggestions.push("Rate limit of 5/min per IP may be too aggressive for multi-project use; consider per-API-key limits");
    }
    const testFails = testResults.filter((r) => !r.success && !r.rateLimited).length;
    if (testFails > 0) {
      issues.push(`${testFails} test attestations failed outright`);
    }
  }

  // Capacity suggestions
  if (reachableMiners.length < 3) {
    suggestions.push("Only " + reachableMiners.length + " reachable miner(s); more miners improve throughput and fault tolerance");
  }
  if (attestVals.length < 2) {
    suggestions.push("Only " + attestVals.length + " attest-capable validator(s); single point of failure risk");
  }
  suggestions.push("Consider exposing Prometheus /metrics to a Grafana dashboard for continuous monitoring");
  suggestions.push("Add persistent request logging in the web /api/attest route (currently ephemeral, lost on Vercel cold starts)");

  if (issues.length > 0) {
    console.log("    Issues found:");
    for (const issue of issues) console.log(`      - ${issue}`);
  } else {
    console.log("    No critical issues detected");
  }

  if (suggestions.length > 0) {
    console.log("\n    Suggestions:");
    for (const s of suggestions) console.log(`      - ${s}`);
  }

  // ── Capacity Estimate ──
  console.log("\n  CAPACITY ESTIMATE");
  // Each miner: ATTEST_MAX_CONCURRENT=5, avg time ~60s = ~5 proofs/min sustained
  // Each notary: NOTARY_MAX_CONCURRENT=4
  // Each validator: ATTEST_MAX_CONCURRENT=15
  // Rate limit: 5/min per IP (web endpoint)
  const totalMinerSlots = reachableMiners.reduce((s, m) => s + (m.tlsn_max || 5), 0);
  const totalNotarySlots = reachableMiners.reduce((s, m) => s + (m.notary_max || 4), 0);
  const totalValSlots = attestVals.reduce((s, _) => s + 15, 0); // default 15

  if (testResults) {
    const okTests = testResults.filter((r) => r.success);
    const avgTime = okTests.length > 0 ? okTests.reduce((s, r) => s + r.elapsed, 0) / okTests.length : 60;
    const throughputPerMin = totalMinerSlots * (60 / avgTime);

    console.log(`    Miner prover slots: ${totalMinerSlots}`);
    console.log(`    Notary MPC slots: ${totalNotarySlots}`);
    console.log(`    Validator dispatch slots: ${totalValSlots}`);
    console.log(`    Avg attestation time: ${avgTime.toFixed(1)}s`);
    console.log(`    Estimated throughput: ~${throughputPerMin.toFixed(1)} attestations/min (theoretical max)`);
    console.log(`    Web rate limit: 5/min per IP (bottleneck for single-client use)`);
  } else {
    console.log(`    Miner prover slots: ${totalMinerSlots}`);
    console.log(`    Notary MPC slots: ${totalNotarySlots}`);
    console.log(`    Validator dispatch slots: ${totalValSlots}`);
  }

  hr();
  console.log("  Report complete at " + new Date().toISOString());
  hr();
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  DJINN ATTESTATION HEALTH MONITOR                                          ║");
  console.log("║  SN103 Network Status, Telemetry, and Live Testing                         ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`  Mode: ${SKIP_TESTS ? "telemetry-only" : TESTS_ONLY ? "tests-only" : "full"}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);

  // Phase 1: Health
  const health = await phaseNodeHealth();

  // Phase 2: Telemetry
  let telemetry = null;
  if (!TESTS_ONLY) {
    telemetry = await phaseTelemetry(health.validators);
  }

  // Phase 3: Live Tests
  let testResults = null;
  if (!SKIP_TESTS) {
    testResults = await phaseTests();
  }

  // Phase 4: Report
  phaseReport(health, telemetry || {}, testResults);

  // Save results to file
  const output = {
    timestamp: new Date().toISOString(),
    health: {
      validators: health.validators.map((v) => ({ uid: v.uid, label: v.label, reachable: v.reachable, version: v.version, attest_capable: v.attest_capable })),
      miners: health.miners.map((m) => ({ uid: m.uid, label: m.label, reachable: m.reachable, version: m.version, tlsn_binary: m.tlsn_binary, notary_enabled: m.notary_enabled })),
    },
    telemetry: telemetry ? {
      attestation_count: telemetry.attestations?.length || 0,
      miner_scores: telemetry.minerScores,
    } : null,
    tests: testResults,
  };

  const outPath = new URL("../test-results/attest-health.json", import.meta.url).pathname;
  const { writeFileSync, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n  Results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
