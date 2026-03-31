import { NextResponse } from "next/server";
import { discoverMetagraph, isPublicIp } from "@/lib/bt-metagraph";

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

    const valNode = nodes.find(
      (n) =>
        n.uid === uid &&
        n.isValidator &&
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        isPublicIp(n.ip),
    );

    if (!valNode) {
      return NextResponse.json(
        { uid, found: false, error: "Validator not found or unreachable" },
        { status: 404 },
      );
    }

    const metagraph = {
      ip: valNode.ip,
      port: valNode.port,
      stake: valNode.totalStake.toString(),
      incentive: valNode.incentive,
      emission: valNode.emission.toString(),
      validatorTrust: valNode.validatorTrust,
    };

    // Probe health
    let health = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://${valNode.ip}:${valNode.port}/health`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeout);
      if (res.ok) health = await res.json();
    } catch {
      // Health probe failed, continue without it
    }

    // Fetch all miners this validator scores
    let miners: Record<string, unknown>[] = [];
    let validatorUid: number | null = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `http://${valNode.ip}:${valNode.port}/v1/network/miners`,
        { signal: controller.signal, cache: "no-store" },
      );
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        miners = data.miners || [];
        validatorUid = data.validator_uid ?? null;
      }
    } catch {
      // Miner data fetch failed, continue with empty list
    }

    return NextResponse.json(
      { uid, found: true, metagraph, health, miners, validatorUid },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      },
    );
  } catch (err) {
    console.error("[network/validator] Failed:", err);
    return NextResponse.json(
      { uid, found: false, error: "Failed to load validator data" },
      { status: 500 },
    );
  }
}
