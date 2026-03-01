import { NextRequest, NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_PATHS = new Set(["health", "v1/signal", "v1/activity", "v1/attest", "v1/attest/capacity", "v1/admin/attestations", "v1/telemetry"]);
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
  const node = nodes.find((n) => n.uid === uid && n.port > 0 && n.ip !== "0.0.0.0");
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
  return allowed.includes(origin) || origin.endsWith(".djinn.vercel.app");
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

  try {
    const res = await fetch(target, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Validator unavailable" },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
