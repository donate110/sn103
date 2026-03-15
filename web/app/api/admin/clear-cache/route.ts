import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/admin-auth";
import { clearMetagraphCache } from "@/lib/bt-metagraph";

export async function POST(request: NextRequest) {
  if (!(await verifyAdminRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  clearMetagraphCache();
  return NextResponse.json({ ok: true, cleared: Date.now() });
}
