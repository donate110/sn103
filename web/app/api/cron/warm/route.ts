import { NextResponse } from "next/server";

/**
 * GET /api/cron/warm
 *
 * Pre-warms serverless functions and populates server-side caches.
 * Called by Vercel cron every 5 minutes to keep functions warm
 * so users never hit cold-start latency.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Verify cron secret to prevent abuse
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://www.djinn.gg";
  const endpoints = [
    "/api/health",
    "/api/idiot/browse?limit=1",
    "/api/network/status",
    "/api/validators/discover",
    "/api/odds?sport=basketball_nba",
  ];

  const results: Record<string, { status: number; ms: number }> = {};

  await Promise.allSettled(
    endpoints.map(async (ep) => {
      const start = Date.now();
      try {
        const res = await fetch(`${base}${ep}`, {
          headers: { "User-Agent": "djinn-cron-warmer" },
        });
        results[ep] = { status: res.status, ms: Date.now() - start };
      } catch {
        results[ep] = { status: 0, ms: Date.now() - start };
      }
    }),
  );

  return NextResponse.json({ warmed: true, results });
}
