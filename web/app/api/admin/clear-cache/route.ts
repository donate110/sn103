import { NextResponse } from "next/server";
import { clearMetagraphCache } from "@/lib/bt-metagraph";

export async function POST() {
  clearMetagraphCache();
  return NextResponse.json({ ok: true, cleared: Date.now() });
}
