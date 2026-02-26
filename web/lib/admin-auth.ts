import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function getSecret(): string {
  return process.env.ADMIN_PASSWORD || "";
}

export function signToken(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function createToken(): string {
  const payload = `djinn-admin:${Date.now()}`;
  const sig = signToken(payload);
  return Buffer.from(`${payload}:${sig}`).toString("base64");
}

export function verifyToken(token: string): boolean {
  const secret = getSecret();
  if (!secret) return false;
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
 * Verify an admin request via cookie (HMAC-signed token) or Bearer password.
 * Returns true if authenticated, false otherwise.
 */
export function verifyAdminRequest(request: NextRequest): boolean {
  // 1. Try httpOnly cookie with full HMAC verification
  const cookie = request.cookies.get("djinn_admin_token")?.value;
  if (cookie && verifyToken(cookie)) {
    return true;
  }

  // 2. Fall back to Bearer token (timing-safe password comparison)
  const authHeader = request.headers.get("authorization");
  const bearerPassword = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;
  const expected = process.env.ADMIN_PASSWORD;
  if (
    !expected ||
    !bearerPassword ||
    bearerPassword.length !== expected.length ||
    !timingSafeEqual(Buffer.from(bearerPassword), Buffer.from(expected))
  ) {
    return false;
  }

  return true;
}
