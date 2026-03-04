import { NextResponse } from "next/server";
import { discoverMetagraph, discoverMinerUrl } from "@/lib/bt-metagraph";

/**
 * GET /api/debug/metagraph — diagnostic endpoint for metagraph discovery.
 * Returns what the server sees when discovering miners and validators.
 */
export async function GET() {
  const env = {
    BT_NETUID: process.env.BT_NETUID ?? "(unset)",
    BT_NETWORK: process.env.BT_NETWORK ?? "(unset)",
    BT_RPC_URL: process.env.BT_RPC_URL ?? "(unset)",
    MINER_URL: process.env.MINER_URL ? "(set)" : "(unset)",
    NEXT_PUBLIC_MINER_URL: process.env.NEXT_PUBLIC_MINER_URL ? "(set)" : "(unset)",
  };

  try {
    const start = Date.now();
    const snap = await discoverMetagraph();
    const discoveryMs = Date.now() - start;

    const nodes = snap.nodes;
    const publicNodes = nodes.filter(
      (n) => n.port > 0 && n.ip !== "0.0.0.0" && !n.ip.startsWith("127.") && !n.ip.startsWith("10.") && !n.ip.startsWith("192.168."),
    );
    const validators = publicNodes.filter((n) => n.isValidator);
    const miners = publicNodes.filter((n) => !n.isValidator);

    const minerStart = Date.now();
    const minerUrl = await discoverMinerUrl();
    const minerDiscoveryMs = Date.now() - minerStart;

    return NextResponse.json({
      env,
      discoveryMs,
      minerDiscoveryMs,
      totalNodes: nodes.length,
      publicNodes: publicNodes.length,
      validators: validators.length,
      miners: miners.length,
      minerUrl,
      cacheAge: snap.fetchedAt ? Date.now() - snap.fetchedAt : null,
      topMiners: miners.slice(0, 5).map((n) => ({
        uid: n.uid,
        ip: n.ip,
        port: n.port,
      })),
      topValidators: validators.slice(0, 5).map((n) => ({
        uid: n.uid,
        ip: n.ip,
        port: n.port,
        stake: n.totalStake.toString(),
      })),
    });
  } catch (err) {
    return NextResponse.json({
      env,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
