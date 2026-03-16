import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";
import { hexToSs58 } from "@/lib/ss58";

export const revalidate = 120; // ISR: rebuild every 2 minutes

interface NodeInfo {
  uid: number;
  ip: string;
  port: number;
  hotkey: string;
  ss58Hotkey: string;
  stake: string;
  incentive: number;
  emission: string;
  isValidator: boolean;
  trust: number;
  validatorTrust: number;
  dividends: number;
  consensus: number;
}

interface HealthResult {
  uid: number;
  status: string;
  version: string;
  shares_held?: number;
  odds_api_connected?: boolean;
  bt_connected?: boolean;
  chain_connected?: boolean;
  attest_capable?: boolean;
  uptime_seconds?: number;
  error?: string;
}

interface ValidatorMinerData {
  uid: number;
  status: string;
  uptime: number;
  health_checks_total: number;
  health_checks_responded: number;
  queries_total: number;
  queries_correct: number;
  accuracy: number;
  attestations_total: number;
  attestations_valid: number;
  proactive_proof_verified: boolean;
  weight: number;
}

async function probeHealth(
  ip: string,
  port: number,
  uid: number,
): Promise<HealthResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${ip}:${port}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return { uid, status: "error", version: "", error: `HTTP ${res.status}` };
    const data = await res.json();
    return { uid, ...data };
  } catch {
    return { uid, status: "unreachable", version: "", error: "timeout" };
  }
}

/**
 * Fetch miner scoring data from a validator's /v1/network/miners endpoint.
 * This gives us the validator's view of miner health (probed from the
 * validator's IP, which miners whitelist) instead of probing from Vercel.
 */
async function fetchValidatorMinerData(
  ip: string,
  port: number,
): Promise<ValidatorMinerData[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`http://${ip}:${port}/v1/network/miners`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return data.miners || [];
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const { nodes } = await discoverMetagraph();

    const reachable = nodes.filter(
      (n) =>
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        !n.ip.startsWith("10.") &&
        !n.ip.startsWith("192.168.") &&
        !n.ip.startsWith("127."),
    );

    const allNodes: NodeInfo[] = reachable.map((n) => ({
      uid: n.uid,
      ip: n.ip,
      port: n.port,
      hotkey: n.hotkey,
      ss58Hotkey: hexToSs58(n.hotkey),
      stake: n.totalStake.toString(),
      incentive: n.incentive,
      emission: n.emission.toString(),
      isValidator: n.isValidator,
      trust: n.trust,
      validatorTrust: n.validatorTrust,
      dividends: n.dividends,
      consensus: n.consensus,
    }));

    const validators = allNodes.filter((n) => n.isValidator);
    const miners = allNodes.filter((n) => !n.isValidator);

    // Probe validator health directly (few nodes, always reachable)
    const valHealthPromises = validators.map((v) => probeHealth(v.ip, v.port, v.uid));
    const valHealthResults = await Promise.allSettled(valHealthPromises);
    const healthMap: Record<number, HealthResult> = {};
    for (const r of valHealthResults) {
      if (r.status === "fulfilled") {
        healthMap[r.value.uid] = r.value;
      }
    }

    // For miner health: pull from validators instead of probing directly.
    // Validators already health-check every miner each epoch from their
    // whitelisted IPs, so this data is more accurate than Vercel probing.
    const minerHealthFromValidators: Record<number, ValidatorMinerData> = {};
    const valMinerPromises = validators.map((v) =>
      fetchValidatorMinerData(v.ip, v.port),
    );
    const valMinerResults = await Promise.allSettled(valMinerPromises);
    for (const r of valMinerResults) {
      if (r.status !== "fulfilled") continue;
      for (const m of r.value) {
        // Use the validator with the most data for each miner
        const existing = minerHealthFromValidators[m.uid];
        if (!existing || m.health_checks_total > existing.health_checks_total) {
          minerHealthFromValidators[m.uid] = m;
        }
      }
    }

    // Build miner health from validator data
    for (const m of miners) {
      const vData = minerHealthFromValidators[m.uid];
      if (vData) {
        healthMap[m.uid] = {
          uid: m.uid,
          status: vData.status === "ok" ? "ok" : "unreachable",
          version: "",
          // Relay validator-observed metrics as health fields
          bt_connected: vData.uptime > 0.5,
          odds_api_connected: vData.queries_total > 0 ? vData.accuracy > 0 : undefined,
          uptime_seconds: vData.health_checks_total * 12, // ~12s per epoch
        };
      }
    }

    // Compute summary stats
    const validatorHealth = validators.map((v) => healthMap[v.uid]).filter(Boolean);
    const minerStatusList = miners.map((m) => minerHealthFromValidators[m.uid]).filter(Boolean);

    const summary = {
      totalValidators: validators.length,
      totalMiners: miners.length,
      validatorsRunningDjinn: validatorHealth.filter(
        (h) => h.version && h.version !== "0",
      ).length,
      validatorsHealthy: validatorHealth.filter((h) => h.status === "ok").length,
      validatorsHoldingShares: validatorHealth.filter(
        (h) => (h.shares_held ?? 0) > 0,
      ).length,
      totalShares: validatorHealth.reduce(
        (sum, h) => sum + (h.shares_held ?? 0),
        0,
      ),
      minersRunningDjinn: minerStatusList.filter(
        (m) => m.uptime > 0.5,
      ).length,
      minersHealthy: minerStatusList.filter((m) => m.status === "ok").length,
      minersOddsConnected: minerStatusList.filter(
        (m) => m.queries_total > 0,
      ).length,
      minersBtConnected: minerStatusList.filter((m) => m.uptime > 0).length,
      attestCapableMiners: minerStatusList.filter(
        (m) => m.proactive_proof_verified,
      ).length,
      attestCapableValidators: validatorHealth.filter(
        (h) =>
          h.version &&
          parseInt(h.version, 10) >= 512,
      ).length,
      highestVersion: Math.max(
        0,
        ...validatorHealth
          .map((h) => parseInt(h.version || "0", 10))
          .filter((v) => !isNaN(v)),
      ),
      timestamp: Date.now(),
    };

    // Build node arrays with health merged
    const validatorList = validators
      .sort((a, b) => parseFloat(b.stake) - parseFloat(a.stake))
      .map((v) => ({
        ...v,
        health: healthMap[v.uid] || null,
      }));

    const minerList = miners
      .sort((a, b) => b.incentive - a.incentive)
      .map((m) => ({
        ...m,
        health: healthMap[m.uid] || null,
        scoring: minerHealthFromValidators[m.uid] || null,
      }));

    return NextResponse.json(
      { summary, validators: validatorList, miners: minerList },
      {
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    console.error("[network/status] Failed:", err);
    return NextResponse.json(
      { error: "Network status unavailable", summary: null, validators: [], miners: [] },
      { status: 500 },
    );
  }
}
