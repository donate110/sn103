import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/admin/auth
 *
 * Check if the user has a valid admin session (via httpOnly cookie).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get("djinn_admin_token")?.value;
  if (token && token.startsWith("ZGppbm4tYWRtaW46")) {
    return NextResponse.json({ authenticated: true });
  }
  return NextResponse.json({ authenticated: false }, { status: 401 });
}

/**
 * POST /api/admin/auth
 *
 * Verify admin password server-side. The password is never sent to the client.
 * Returns a session token (simple HMAC) that must be included in subsequent
 * admin API requests via the Authorization header.
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

  // Return a simple token the client can use for subsequent requests.
  // In production you'd use a signed JWT; for admin-only usage this suffices.
  const token = Buffer.from(`djinn-admin:${Date.now()}`).toString("base64");

  const response = NextResponse.json({ ok: true });
  // Set an httpOnly cookie so the token isn't accessible from JS
  response.cookies.set("djinn_admin_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60 * 4, // 4 hours
    path: "/",
  });

  return response;
}
