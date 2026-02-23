import { NextRequest, NextResponse } from "next/server";
import { discoverValidatorUrl } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

const ALLOWED_PATHS = new Set(["health", "v1/signal", "v1/attest"]);
const PURCHASE_RE = /^v1\/signal\/[a-zA-Z0-9_-]+\/purchase$/;
const STATUS_RE = /^v1\/signal\/[a-zA-Z0-9_-]+\/status$/;
const ATTEST_CREDITS_RE = /^v1\/attest\/credits\/[a-fA-F0-9x]+$/;

async function getValidatorUrl(): Promise<string> {
  // 1. Explicit env var takes priority (allows manual override)
  const envUrl = process.env.VALIDATOR_URL || process.env.NEXT_PUBLIC_VALIDATOR_URL;
  if (envUrl) return envUrl;

  // 2. Metagraph discovery — reads the BT chain for SN103 validator axons
  try {
    const discovered = await discoverValidatorUrl();
    if (discovered) return discovered;
  } catch {
    // fall through
  }

  // 3. Localhost fallback for local dev
  return "http://localhost:8421";
}

function isAllowed(path: string): boolean {
  return ALLOWED_PATHS.has(path) || PURCHASE_RE.test(path) || STATUS_RE.test(path) || ATTEST_CREDITS_RE.test(path);
}

function isValidOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin") ?? "";
  if (!origin) return true; // same-origin requests omit Origin
  const allowed = [
    process.env.NEXT_PUBLIC_APP_URL || "https://djinn.gg",
    "https://www.djinn.gg",
    ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
  ];
  return allowed.includes(origin) || origin.endsWith(".vercel.app");
}

async function proxy(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  if (isRateLimited("validator-proxy", getIp(request))) {
    return rateLimitResponse();
  }

  // CSRF: validate Origin header on state-changing requests
  if (request.method === "POST" && !isValidOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = params.path.join("/");
  if (!isAllowed(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const target = `${await getValidatorUrl()}/${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
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
