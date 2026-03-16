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

    // Probe health for all nodes (concurrent, 5s timeout each)
    const healthPromises = reachable.map((n) => probeHealth(n.ip, n.port, n.uid));
    const healthResults = await Promise.allSettled(healthPromises);
    const healthMap: Record<number, HealthResult> = {};
    for (const r of healthResults) {
      if (r.status === "fulfilled") {
        healthMap[r.value.uid] = r.value;
      }
    }

    // Compute summary stats
    const validatorHealth = validators.map((v) => healthMap[v.uid]).filter(Boolean);
    const minerHealth = miners.map((m) => healthMap[m.uid]).filter(Boolean);

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
      minersRunningDjinn: minerHealth.filter(
        (h) => h.version && h.version !== "0",
      ).length,
      minersHealthy: minerHealth.filter((h) => h.status === "ok").length,
      minersOddsConnected: minerHealth.filter(
        (h) => h.odds_api_connected,
      ).length,
      minersBtConnected: minerHealth.filter((h) => h.bt_connected).length,
      attestCapableMiners: minerHealth.filter(
        (h) =>
          h.version &&
          parseInt(h.version, 10) >= 512,
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
        ...minerHealth
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
