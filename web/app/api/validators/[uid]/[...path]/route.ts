import { NextRequest, NextResponse } from "next/server";
import { discoverMetagraph, isPublicIp } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_PATHS = new Set(["health", "v1/signal", "v1/check", "v1/activity", "v1/attest", "v1/attest/capacity", "v1/telemetry"]);
const PURCHASE_RE = /^v1\/signal\/[a-zA-Z0-9_-]+\/purchase$/;
const REGISTER_RE = /^v1\/signal\/[a-zA-Z0-9_-]+\/register$/;
const STATUS_RE = /^v1\/signal\/[a-zA-Z0-9_-]+\/status$/;
const ATTEST_CREDITS_RE = /^v1\/attest\/credits\/[a-fA-F0-9x]+$/;
const MINER_SCORES_RE = /^v1\/miner\/\d+\/scores$/;

function isAllowed(path: string): boolean {
  return ALLOWED_PATHS.has(path) || PURCHASE_RE.test(path) || REGISTER_RE.test(path) || STATUS_RE.test(path) || ATTEST_CREDITS_RE.test(path) || MINER_SCORES_RE.test(path);
}

async function resolveValidatorUrl(uid: number): Promise<string | null> {
  const { nodes } = await discoverMetagraph();
  const node = nodes.find((n) => n.uid === uid && n.port > 0 && n.ip !== "0.0.0.0" && isPublicIp(n.ip));
  if (!node) return null;
  return `http://${node.ip}:${node.port}`;
}

function isValidOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin") ?? "";
  if (!origin) return true; // same-origin requests omit Origin
  const allowed = [
    process.env.NEXT_PUBLIC_APP_URL || "https://djinn.gg",
    "https://www.djinn.gg",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
  ];
  return allowed.includes(origin) || origin.endsWith(".djinn-inc-djinn.vercel.app");
}

async function proxy(
  request: NextRequest,
  { params }: { params: { uid: string; path: string[] } },
) {
  if (isRateLimited("validator-uid-proxy", getIp(request))) {
    return rateLimitResponse();
  }

  // CSRF: validate Origin header on state-changing requests
  if (request.method === "POST" && !isValidOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const uid = parseInt(params.uid, 10);
  if (isNaN(uid) || uid < 0 || uid > 65535) {
    return NextResponse.json({ error: "Invalid UID" }, { status: 400 });
  }

  const path = params.path.join("/");
  if (!isAllowed(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseUrl = await resolveValidatorUrl(uid);
  if (!baseUrl) {
    return NextResponse.json(
      { error: `Validator UID ${uid} not found in metagraph` },
      { status: 404 },
    );
  }

  const target = `${baseUrl}/${path}`;
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

  // Purchase + MPC endpoints need longer timeouts: distributed MPC runs
  // 10 sequential gate computations across multiple validators (~50s).
  const isPurchaseOrMPC = path.includes("purchase") || path.includes("mpc/");
  const timeoutMs = isPurchaseOrMPC ? 120_000 : 30_000;

  try {
    const res = await fetch(target, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.name : "unknown";
    console.error(`[proxy] UID ${uid} -> ${target} failed: ${errName}: ${errMsg}`);
    return NextResponse.json(
      {
        error: "Validator unavailable",
        detail: errName === "TimeoutError" ? "timeout" : errName === "TypeError" ? "connection_refused" : errName,
        target: target.replace(/\d+\.\d+\.\d+\.\d+/, "x.x.x.x"), // Redact IP
        timeout_ms: timeoutMs,
      },
      { status: 502 },
    );
  }
}

// MPC purchase verification takes 30-90s depending on network conditions
// and validator count. Vercel Pro allows up to 300s.
// Set to 120s to accommodate MPC + OT triple generation + retries.
export const maxDuration = 120;

export const GET = proxy;
export const POST = proxy;
