import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/admin-auth";
import { getErrors } from "@/lib/error-store";

/**
 * GET /api/admin/errors?limit=50
 *
 * Returns recent error reports from the in-memory ring buffer.
 * Protected by admin session cookie (set via POST /api/admin/auth).
 */

export async function GET(request: NextRequest) {
  if (!(await verifyAdminRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);

  const result = getErrors(limit);
  return NextResponse.json(result);
}
