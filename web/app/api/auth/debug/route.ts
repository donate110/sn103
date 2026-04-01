import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/api-auth";

/**
 * POST /api/auth/debug
 * Temporary debug endpoint - verifies a token and returns diagnostic info.
 * Remove after debugging.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const secretLen = (process.env.API_SESSION_SECRET || process.env.ADMIN_PASSWORD || "").length;

    const result = await verifySessionToken(token);

    return NextResponse.json({
      secret_source: process.env.API_SESSION_SECRET ? "API_SESSION_SECRET" : process.env.ADMIN_PASSWORD ? "ADMIN_PASSWORD" : "NONE",
      secret_length: secretLen,
      token_starts_with: token.slice(0, 10),
      token_length: token.length,
      verified: result !== null,
      payload: result ? { address: result.address, expired: Date.now() > result.expiresAt } : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
