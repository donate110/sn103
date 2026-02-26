import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/admin-auth";

/**
 * GET /api/admin/errors?limit=50
 *
 * Returns recent error reports from the local JSONL log.
 * Protected by admin session cookie (set via POST /api/admin/auth).
 */

export async function GET(request: NextRequest) {
  if (!verifyAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);

  try {
    const { readFile } = await import("fs/promises");
    const dir = process.env.ERROR_REPORT_DIR || "/tmp/djinn-error-reports";
    const content = await readFile(`${dir}/errors.jsonl`, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const errors = lines
      .slice(-limit)
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return NextResponse.json({ errors, total: lines.length });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ errors: [], total: 0 });
    }
    return NextResponse.json(
      { error: "Failed to read error logs" },
      { status: 500 },
    );
  }
}
