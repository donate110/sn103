import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";

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

    const validators = pool
      .sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0))
      .map((n) => ({ uid: n.uid, ip: n.ip, port: n.port, hotkey: n.hotkey, stake: n.stake.toString() }));

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
