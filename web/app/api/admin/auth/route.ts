import { NextRequest, NextResponse } from "next/server";
import { createToken, verifyToken } from "@/lib/admin-auth";

/**
 * GET /api/admin/auth
 *
 * Check if the user has a valid admin session (via httpOnly cookie).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("djinn_admin_token")?.value;
  if (token && (await verifyToken(token))) {
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

  if (
    !body.password ||
    body.password.length !== expected.length ||
    !constantTimeEqual(body.password, expected)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = await createToken();

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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}
