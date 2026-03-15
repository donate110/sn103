import { NextRequest, NextResponse } from "next/server";
import { discoverMinerUrl } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_PATHS = new Set(["health", "v1/check"]);

async function getMinerUrl(): Promise<string> {
  // 1. Explicit env var takes priority
  const envUrl = process.env.MINER_URL || process.env.NEXT_PUBLIC_MINER_URL;
  if (envUrl) return envUrl;

  // 2. Metagraph discovery
  try {
    const discovered = await discoverMinerUrl();
    if (discovered) return discovered;
  } catch {
    // fall through
  }

  // 3. Localhost fallback
  return "http://localhost:8422";
}

function isValidOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin") ?? "";
  if (!origin) return true;
  const allowed = [
    process.env.NEXT_PUBLIC_APP_URL || "https://djinn.gg",
    "https://www.djinn.gg",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
  ];
  return allowed.includes(origin) || origin.endsWith(".djinn-inc-djinn.vercel.app");
}

async function proxy(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  if (isRateLimited("miner-proxy", getIp(request))) {
    return rateLimitResponse();
  }

  if (request.method === "POST" && !isValidOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = params.path.join("/");
  if (!ALLOWED_PATHS.has(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const target = `${await getMinerUrl()}/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const MAX_BODY = 1_000_000; // 1 MB
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const cl = parseInt(request.headers.get("content-length") || "0");
    if (cl > MAX_BODY) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    init.body = await request.text();
  }

  try {
    const res = await fetch(target, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
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
export const POST = proxy;
