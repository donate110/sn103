import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, authenticateRequest } from "@/lib/api-auth";

/**
 * POST /api/auth/debug
 * Temporary debug endpoint - verifies a token and tests authenticateRequest.
 * Remove after debugging.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    const secretLen = (process.env.API_SESSION_SECRET || process.env.ADMIN_PASSWORD || "").length;
    const authHeader = request.headers.get("authorization");

    // Test direct token verification
    const directResult = token ? await verifySessionToken(token) : null;

    // Test authenticateRequest (reads Authorization header)
    const authResult = await authenticateRequest(request);

    return NextResponse.json({
      secret_source: process.env.API_SESSION_SECRET ? "API_SESSION_SECRET" : process.env.ADMIN_PASSWORD ? "ADMIN_PASSWORD" : "NONE",
      secret_length: secretLen,
      auth_header_present: !!authHeader,
      auth_header_starts: authHeader?.slice(0, 20) || null,
      direct_verify: directResult !== null,
      authenticate_request: authResult !== null,
      authenticate_result: authResult,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
