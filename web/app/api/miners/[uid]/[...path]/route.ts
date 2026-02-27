import { NextRequest, NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_PATHS = new Set(["health", "v1/telemetry"]);

async function resolveMinerUrl(uid: number): Promise<string | null> {
  const { nodes } = await discoverMetagraph();
  const node = nodes.find((n) => n.uid === uid && n.port > 0 && n.ip !== "0.0.0.0");
  if (!node) return null;
  return `http://${node.ip}:${node.port}`;
}

async function proxy(
  request: NextRequest,
  { params }: { params: { uid: string; path: string[] } },
) {
  if (isRateLimited("miner-uid-proxy", getIp(request))) {
    return rateLimitResponse();
  }

  const uid = parseInt(params.uid, 10);
  if (isNaN(uid) || uid < 0 || uid > 65535) {
    return NextResponse.json({ error: "Invalid UID" }, { status: 400 });
  }

  const path = params.path.join("/");
  if (!ALLOWED_PATHS.has(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseUrl = await resolveMinerUrl(uid);
  if (!baseUrl) {
    return NextResponse.json(
      { error: `Miner UID ${uid} not found in metagraph` },
      { status: 404 },
    );
  }

  const target = `${baseUrl}/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Miner unavailable" },
      { status: 502 },
    );
  }
}

export const GET = proxy;
