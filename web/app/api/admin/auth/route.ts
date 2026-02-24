import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSecret(): string {
  return process.env.ADMIN_PASSWORD || "";
}

function signToken(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function createToken(): string {
  const payload = `djinn-admin:${Date.now()}`;
  const sig = signToken(payload);
  return Buffer.from(`${payload}:${sig}`).toString("base64");
}

function verifyToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;

    const [prefix, timestampStr, sig] = parts;
    if (prefix !== "djinn-admin") return false;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp) || Date.now() - timestamp > TOKEN_TTL_MS) return false;

    const expectedSig = signToken(`${prefix}:${timestampStr}`);
    if (sig.length !== expectedSig.length) return false;
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

/**
 * GET /api/admin/auth
 *
 * Check if the user has a valid admin session (via httpOnly cookie).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("djinn_admin_token")?.value;
  if (token && verifyToken(token)) {
    return NextResponse.json({ authenticated: true });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}

/**
 * POST /api/admin/auth
 *
 * Verify admin password server-side. The password is never sent to the client.
 * Returns an HMAC-signed session token stored as an httpOnly cookie.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: "Admin authentication not configured" },
      { status: 503 },
    );
  }

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.password || body.password !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = createToken();

  const response = NextResponse.json({ ok: true });
  response.cookies.set("djinn_admin_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 4, // 4 hours
    path: "/",
  });

  return response;
}
