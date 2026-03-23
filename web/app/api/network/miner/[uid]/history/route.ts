import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";

/**
 * Miner score history. Queries validators' public /v1/miner/{uid}/history
 * endpoint which extracts per-miner weight data from telemetry. No admin
 * key required.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid: uidStr } = await params;
  const uid = parseInt(uidStr, 10);
  if (isNaN(uid) || uid < 0 || uid > 65535) {
    return NextResponse.json({ error: "Invalid UID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const hours = parseInt(url.searchParams.get("hours") ?? "168", 10);

  try {
    const { nodes } = await discoverMetagraph();

    const validators = nodes.filter(
      (n) =>
        n.isValidator &&
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        !n.ip.startsWith("10.") &&
        !n.ip.startsWith("192.168.") &&
        !n.ip.startsWith("127."),
    );

    if (validators.length === 0) {
      return NextResponse.json(
        { uid, history: [] },
        { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
      );
    }

    // Query highest-stake validator (most reliable/complete data)
    const topValidator = validators.sort((a, b) =>
      b.totalStake > a.totalStake ? 1 : -1,
    )[0];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(
      `http://${topValidator.ip}:${topValidator.port}/v1/miner/${uid}/history?hours=${hours}`,
      { signal: controller.signal, cache: "no-store" },
    );
    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json(
        { uid, history: [] },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
      );
    }

    const data = await res.json();
    return NextResponse.json(
      { uid, history: data.history ?? [] },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (err) {
    console.error("[network/miner/history] Failed:", err);
    return NextResponse.json({ uid, history: [] }, { status: 500 });
  }
}
