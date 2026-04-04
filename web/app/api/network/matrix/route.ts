import { NextResponse } from "next/server";
import { discoverMetagraph, isPublicIp } from "@/lib/bt-metagraph";

/**
 * GET /api/network/matrix
 *
 * Returns a validator x miner scoring matrix.  For each healthy validator,
 * fetches its /v1/network/miners endpoint in parallel and returns per-miner
 * scores keyed by validator UID.
 */

export interface MatrixMinerEntry {
  uid: number;
  hotkey: string;
  status: string;
  weight: number;
  accuracy: number;
  uptime: number;
  queries_total: number;
  queries_correct: number;
  attestations_total: number;
  attestations_valid: number;
  proactive_proof_verified: boolean;
  notary_duties_assigned: number;
  notary_duties_completed: number;
  notary_reliability: number;
}

export interface MatrixValidator {
  uid: number;
  ip: string;
  port: number;
  stake: string;
  version: string | null;
  healthy: boolean;
  miners: Record<number, MatrixMinerEntry>; // keyed by miner UID
}

async function fetchValidatorMiners(
  ip: string,
  port: number,
): Promise<MatrixMinerEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`http://${ip}:${port}/v1/network/miners`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.miners || []) as MatrixMinerEntry[];
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

async function fetchHealth(
  ip: string,
  port: number,
): Promise<{ status: string; version: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`http://${ip}:${port}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function GET() {
  try {
    const { nodes } = await discoverMetagraph();

    const valNodes = nodes.filter(
      (n) =>
        n.isValidator &&
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        isPublicIp(n.ip),
    );

    // Fetch health + miners in parallel for all validators
    const results = await Promise.all(
      valNodes.map(async (v) => {
        const [health, minerList] = await Promise.all([
          fetchHealth(v.ip, v.port),
          fetchValidatorMiners(v.ip, v.port),
        ]);

        const miners: Record<number, MatrixMinerEntry> = {};
        for (const m of minerList) {
          miners[m.uid] = m;
        }

        return {
          uid: v.uid,
          ip: v.ip,
          port: v.port,
          stake: v.totalStake.toString(),
          version: health?.version ?? null,
          healthy: health?.status === "ok",
          miners,
        } satisfies MatrixValidator;
      }),
    );

    // Collect all unique miner UIDs
    const minerUids = new Set<number>();
    for (const v of results) {
      for (const uid of Object.keys(v.miners)) {
        minerUids.add(Number(uid));
      }
    }

    return NextResponse.json(
      {
        validators: results,
        minerUids: [...minerUids].sort((a, b) => a - b),
        timestamp: Date.now(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      },
    );
  } catch (err) {
    console.error("[network/matrix] Failed:", err);
    return NextResponse.json(
      { error: "Failed to load matrix data" },
      { status: 500 },
    );
  }
}
