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

    // Only probe validators (few nodes, fast). Miner detail is on /network/miner/[uid].
    const valHealthResults = await Promise.allSettled(
      validators.map((v) => probeHealth(v.ip, v.port, v.uid)),
    );
    const healthMap: Record<number, HealthResult> = {};
    for (const r of valHealthResults) {
      if (r.status === "fulfilled") healthMap[r.value.uid] = r.value;
    }

    const validatorHealth = validators.map((v) => healthMap[v.uid]).filter(Boolean);

    const summary = {
      totalValidators: validators.length,
      totalMiners: miners.length,
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

    const minerList = miners
      .sort((a, b) => b.incentive - a.incentive)
      .map((n) => ({
        uid: n.uid,
        stake: n.totalStake.toString(),
        incentive: n.incentive,
        emission: n.emission.toString(),
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
