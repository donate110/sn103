import { NextResponse } from "next/server";
import { discoverMiners } from "@/lib/bt-metagraph";
import { hexToSs58 } from "@/lib/ss58";

/**
 * Returns all reachable miner nodes from the metagraph.
 * Used by the admin dashboard to probe each miner's health individually.
 */
export async function GET() {
  try {
    const nodes = await discoverMiners();

    const miners = nodes.map((n) => ({ uid: n.uid, ip: n.ip, port: n.port, hotkey: n.hotkey, coldkey: n.coldkey, ss58Hotkey: hexToSs58(n.hotkey), stake: n.totalStake.toString(), alphaStake: n.alphaStake.toString(), taoStake: n.taoStake.toString(), incentive: n.incentive, emission: n.emission.toString(), rank: n.rank }));

    return NextResponse.json({ miners }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[discover-miners] Metagraph discovery failed:", err);
    return NextResponse.json(
      { error: "Metagraph discovery failed", miners: [] },
      { status: 500 },
    );
  }
}
