import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";
import { hexToSs58 } from "@/lib/ss58";

/**
 * Returns all reachable validator nodes from the metagraph.
 * The client uses this to create per-validator proxy clients for Shamir share distribution.
 */
export async function GET() {
  try {
    const { nodes } = await discoverMetagraph();

    // Filter to nodes with public IPs that could be validators
    const reachable = nodes.filter((n) => n.port > 0 && n.ip !== "0.0.0.0" && !n.ip.startsWith("10.") && !n.ip.startsWith("192.168.") && !n.ip.startsWith("127."));

    // Prefer validators with permit, fall back to any reachable
    const withPermit = reachable.filter((n) => n.isValidator);
    const pool = withPermit.length > 0 ? withPermit : reachable;

    // Health-check validators in parallel (3s timeout) to filter out dead nodes.
    // This prevents the client from wasting time on 502s during purchase/creation.
    const sorted = pool.sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0));
    const healthResults = await Promise.allSettled(
      sorted.map(async (n) => {
        const res = await fetch(`http://${n.ip}:${n.port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return n;
      }),
    );
    const healthy = healthResults
      .filter((r): r is PromiseFulfilledResult<typeof sorted[0]> => r.status === "fulfilled")
      .map((r) => r.value);
    // Fall back to all if health checks fail (e.g., Vercel can't reach validators directly)
    const finalPool = healthy.length > 0 ? healthy : sorted;

    const validators = finalPool
      .map((n) => ({ uid: n.uid, ip: n.ip, port: n.port, hotkey: n.hotkey, coldkey: n.coldkey, ss58Hotkey: hexToSs58(n.hotkey), stake: n.totalStake.toString(), alphaStake: n.alphaStake.toString(), taoStake: n.taoStake.toString(), incentive: n.incentive, emission: n.emission.toString(), consensus: n.consensus, trust: n.trust, validatorTrust: n.validatorTrust, dividends: n.dividends, rank: n.rank }));

    return NextResponse.json({ validators }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[discover] Metagraph discovery failed:", err);
    return NextResponse.json(
      { error: "Metagraph discovery failed", validators: [] },
      { status: 500 },
    );
  }
}
