import { NextRequest, NextResponse } from "next/server";

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60; // 60 requests per minute per IP
const MAX_MAP_SIZE = 5000;

/** Per-route rate limit maps keyed by route name */
const maps: Map<string, Map<string, number[]>> = new Map();

function getMap(route: string): Map<string, number[]> {
  let m = maps.get(route);
  if (!m) {
    m = new Map();
    maps.set(route, m);
  }
  return m;
}

/** Extract client IP from request.
 *
 * Priority: request.ip (framework-trusted) > x-real-ip (set by reverse proxy)
 * > last entry of x-forwarded-for (closest proxy hop, hardest to spoof).
 * The first x-forwarded-for entry is attacker-controllable and must not be used.
 */
export function getIp(request: NextRequest): string {
  if (request.ip) return request.ip;
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

/**
 * Check if a request is rate-limited and record the attempt.
 *
 * @param route   Unique name for this rate-limit bucket
 * @param ip      Client IP
 * @param max     Max requests per window (default 60)
 * @param windowMs  Window duration in ms (default 60_000)
 * @returns true if the request should be rejected
 */
export function isRateLimited(
  route: string,
  ip: string,
  max: number = DEFAULT_MAX_REQUESTS,
  windowMs: number = DEFAULT_WINDOW_MS,
): boolean {
  const map = getMap(route);
  const now = Date.now();
  const timestamps = map.get(ip) || [];
  const recent = timestamps.filter((t) => t > now - windowMs);
  if (recent.length >= max) return true;
  recent.push(now);
  map.set(ip, recent);
  // Evict stale entries
  if (map.size > MAX_MAP_SIZE) {
    for (const [key, ts] of map) {
      if (ts.every((t) => t <= now - windowMs)) {
        map.delete(key);
      }
    }
  }
  return false;
}

/** Standard 429 response */
export function rateLimitResponse(): NextResponse {
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    { status: 429 },
  );
}
