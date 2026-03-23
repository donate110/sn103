import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";

/**
 * Server-side miner lookup. Queries all validators for a miner's scores
 * in parallel from Vercel (single hop to each validator) instead of the
 * browser doing it sequentially through the proxy.
 *
 * Also returns metagraph data (ip, incentive, emission) for display.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid: uidStr } = await params;
  const uid = parseInt(uidStr, 10);
  if (isNaN(uid) || uid < 0 || uid > 65535) {
    return NextResponse.json({ error: "Invalid UID" }, { status: 400 });
  }

  try {
    const { nodes } = await discoverMetagraph();

    // Find this miner in the metagraph
    const minerNode = nodes.find((n) => n.uid === uid);
    const metagraph = minerNode
      ? {
          ip: minerNode.ip || "0.0.0.0",
          incentive: minerNode.incentive,
          emission: minerNode.emission.toString(),
          isValidator: minerNode.isValidator,
          stake: minerNode.totalStake.toString(),
        }
      : null;

    // Find validators (nodes with public IPs that are validators)
    const validators = nodes.filter(
      (n) =>
        n.isValidator &&
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        !n.ip.startsWith("10.") &&
        !n.ip.startsWith("192.168.") &&
        !n.ip.startsWith("127."),
    );

    // Query all validators in parallel (server-side, single hop each)
    const results = await Promise.allSettled(
      validators.map(async (v) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(
            `http://${v.ip}:${v.port}/v1/miner/${uid}/scores`,
            { signal: controller.signal, cache: "no-store" },
          );
          clearTimeout(timeout);
          if (!res.ok) return null;
          const data = await res.json();
          return { validatorUid: v.uid, ...data };
        } catch {
          clearTimeout(timeout);
          return null;
        }
      }),
    );

    const scores = results
      .map((r) => (r.status === "fulfilled" ? r.value : null))
      .filter((r) => r !== null && r.found !== false);

    return NextResponse.json(
      { uid, scores, metagraph },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
        },
      },
    );
  } catch (err) {
    console.error("[network/miner] Failed:", err);
    return NextResponse.json({ uid, scores: [], metagraph: null }, { status: 500 });
  }
}
