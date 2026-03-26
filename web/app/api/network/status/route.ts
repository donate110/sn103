import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";
import { hexToSs58 } from "@/lib/ss58";

export const revalidate = 120;

interface HealthResult {
  uid: number;
  status: string;
  version: string;
  shares_held?: number;
  chain_connected?: boolean;
  bt_connected?: boolean;
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
    if (!res.ok) return { uid, status: "error", version: "" };
    const data = await res.json();
    return { uid, ...data };
  } catch {
    return { uid, status: "unreachable", version: "" };
  }
}

function computeGini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) weightedSum += (i + 1) * sorted[i];
  return (2 * weightedSum) / (n * total) - (n + 1) / n;
}

// In-memory scoring cache (120s TTL). Scoring data changes slowly
// (epoch-level) so caching avoids re-fetching on every page load.
interface ScoringEntry {
  weight: number;
  attestations_total: number;
  attestations_valid: number;
  lifetime_attestations: number;
  lifetime_attestations_valid: number;
  proactive_proof_verified: boolean;
  uptime: number;
  accuracy: number;
  queries_total: number;
  queries_correct: number;
  notary_duties_assigned: number;
  notary_duties_completed: number;
}
let scoringCache: { data: Record<number, ScoringEntry>; fetchedAt: number } | null = null;
const SCORING_CACHE_TTL = 120_000;

async function fetchScoringData(
  ip: string,
  port: number,
): Promise<Record<number, ScoringEntry>> {
  const now = Date.now();
  if (scoringCache && now - scoringCache.fetchedAt < SCORING_CACHE_TTL) {
    return scoringCache.data;
  }
  const result: Record<number, ScoringEntry> = {};
  try {
    const res = await fetch(
      `http://${ip}:${port}/v1/network/miners`,
      { signal: AbortSignal.timeout(5000), cache: "no-store" },
    );
    if (res.ok) {
      const data = await res.json();
      for (const m of data.miners || []) {
        result[m.uid] = {
          weight: m.weight ?? 0,
          attestations_total: m.attestations_total ?? 0,
          attestations_valid: m.attestations_valid ?? 0,
          lifetime_attestations: m.lifetime_attestations ?? 0,
          lifetime_attestations_valid: m.lifetime_attestations_valid ?? 0,
          proactive_proof_verified: m.proactive_proof_verified ?? false,
          uptime: m.uptime ?? 0,
          accuracy: m.accuracy ?? 0,
          queries_total: m.queries_total ?? 0,
          queries_correct: m.queries_correct ?? 0,
          notary_duties_assigned: m.notary_duties_assigned ?? 0,
          notary_duties_completed: m.notary_duties_completed ?? 0,
        };
      }
      scoringCache = { data: result, fetchedAt: now };
    }
  } catch {
    // Best-effort; return stale cache or empty
    if (scoringCache) return scoringCache.data;
  }
  return result;
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

    const validators = reachable.filter((n) => n.isValidator);
    const miners = reachable.filter((n) => !n.isValidator);

    // Also include miners with 0.0.0.0 (ghost nodes) for completeness
    const allMiners = nodes.filter((n) => !n.isValidator);

    // Pick top-stake validator for scoring data (by metagraph stake,
    // before health probes finish). If it's down, fetch fails gracefully.
    const topStakeVal = [...validators].sort(
      (a, b) => (b.totalStake > a.totalStake ? 1 : -1),
    )[0];

    // Fire health probes and scoring fetch in parallel
    const [valHealthResults, scoringData] = await Promise.all([
      Promise.allSettled(
        validators.map((v) => probeHealth(v.ip, v.port, v.uid)),
      ),
      topStakeVal
        ? fetchScoringData(topStakeVal.ip, topStakeVal.port)
        : Promise.resolve({} as Record<number, ScoringEntry>),
    ]);

    const healthMap: Record<number, HealthResult> = {};
    for (const r of valHealthResults) {
      if (r.status === "fulfilled") healthMap[r.value.uid] = r.value;
    }

    const validatorHealth = validators.map((v) => healthMap[v.uid]).filter(Boolean);

    // IP clustering
    const ipClusters: Record<string, number[]> = {};
    const uniqueIps = new Set<string>();
    for (const m of allMiners) {
      const ip = m.ip;
      if (ip && ip !== "0.0.0.0") {
        uniqueIps.add(ip);
        const subnet = ip.split(".").slice(0, 3).join(".");
        (ipClusters[subnet] ??= []).push(m.uid);
      }
    }

    // Gini coefficient of incentive distribution (miners only, excluding UID 0)
    const incentiveValues = allMiners
      .filter((m) => m.uid !== 0)
      .map((m) => m.incentive);
    const giniCoeff = computeGini(incentiveValues);

    // Burn percentage (UID 0 share of total incentive)
    const totalIncentive = nodes.reduce((s, n) => s + n.incentive, 0);
    const uid0 = nodes.find((n) => n.uid === 0);
    const burnPercent =
      totalIncentive > 0 && uid0
        ? (uid0.incentive / totalIncentive) * 100
        : 0;

    const summary = {
      totalValidators: validators.length,
      totalMiners: allMiners.length,
      validatorsHealthy: validatorHealth.filter((h) => h.status === "ok").length,
      validatorsHoldingShares: validatorHealth.filter((h) => (h.shares_held ?? 0) > 0).length,
      totalShares: validatorHealth.reduce((sum, h) => sum + (h.shares_held ?? 0), 0),
      highestVersion: Math.max(
        0,
        ...validatorHealth
          .map((h) => parseInt(h.version || "0", 10))
          .filter((v) => !isNaN(v)),
      ),
      timestamp: Date.now(),
      uniqueIps: uniqueIps.size,
      gini: Math.round(giniCoeff * 1000) / 1000,
      burnPercent: Math.round(burnPercent * 10) / 10,
    };

    const validatorList = validators
      .sort((a, b) => (b.totalStake > a.totalStake ? 1 : -1))
      .map((n) => ({
        uid: n.uid,
        ip: n.ip,
        port: n.port,
        ss58Hotkey: hexToSs58(n.hotkey),
        stake: n.totalStake.toString(),
        incentive: n.incentive,
        emission: n.emission.toString(),
        validatorTrust: n.validatorTrust,
        health: healthMap[n.uid] || null,
      }));

    const minerList = allMiners
      .sort((a, b) => b.incentive - a.incentive)
      .map((n) => ({
        uid: n.uid,
        ip: n.ip || "0.0.0.0",
        stake: n.totalStake.toString(),
        incentive: n.incentive,
        emission: n.emission.toString(),
        ...(scoringData[n.uid] || {}),
      }));

    return NextResponse.json(
      { summary, validators: validatorList, miners: minerList, ipClusters },
      {
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (err) {
    console.error("[network/status] Failed:", err);
    return NextResponse.json(
      { error: "Network status unavailable", summary: null, validators: [], miners: [], ipClusters: {} },
      { status: 500 },
    );
  }
}
