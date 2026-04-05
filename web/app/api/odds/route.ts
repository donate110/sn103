import { NextRequest, NextResponse } from "next/server";

/**
 * Proxies requests to The Odds API, keeping the API key server-side.
 *
 * GET /api/odds?sport=basketball_nba&markets=spreads,totals,h2h
 *
 * Query params:
 *   sport   — The Odds API sport key (required)
 *   markets — Comma-separated markets (default: "spreads,totals,h2h")
 *
 * Returns the raw event array from The Odds API.
 */

const ODDS_API_BASE = "https://api.the-odds-api.com";
const ALLOWED_SPORTS = new Set([
  "basketball_nba",
  "americanfootball_nfl",
  "americanfootball_ncaaf",
  "basketball_ncaab",
  "baseball_mlb",
  "icehockey_nhl",
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_france_ligue_one",
  "soccer_uefa_champs_league",
  "soccer_usa_mls",
  "mma_mixed_martial_arts",
  "tennis_atp_french_open",
  "golf_pga_championship_winner",
  "boxing_boxing",
]);
const ALLOWED_MARKETS = new Set(["spreads", "totals", "h2h"]);
const CACHE_TTL_SECONDS = 60;

let cachedData: Map<string, { data: unknown; expiresAt: number }> = new Map();

// Simple sliding-window rate limiter per IP
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // 120 requests per minute per IP (v2 signal creation fetches alt lines per game)
const rateLimitMap: Map<string, number[]> = new Map();

function getRateLimitKey(request: NextRequest): string {
  // Prefer Next.js-provided IP (set by trusted proxy/platform), fall back to
  // x-real-ip (single value, harder to spoof than x-forwarded-for).
  // Avoid x-forwarded-for as primary source since it is trivially spoofable.
  return (
    request.ip ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  // Evict stale IPs periodically
  if (rateLimitMap.size > 1000) {
    for (const [key, ts] of rateLimitMap) {
      if (ts.every((t) => t <= now - RATE_LIMIT_WINDOW_MS)) {
        rateLimitMap.delete(key);
      }
    }
  }
  return false;
}

function evictStale() {
  const now = Date.now();
  for (const [key, entry] of cachedData) {
    if (entry.expiresAt <= now) cachedData.delete(key);
  }
  if (cachedData.size > 50) {
    const keys = [...cachedData.keys()];
    for (const k of keys.slice(0, keys.length - 50)) cachedData.delete(k);
  }
}

export async function GET(request: NextRequest) {
  if (isRateLimited(getRateLimitKey(request))) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 },
    );
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Odds API key not configured (set ODDS_API_KEY env var)" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");
  if (!sport || !ALLOWED_SPORTS.has(sport)) {
    return NextResponse.json(
      {
        error: `Invalid sport. Allowed: ${[...ALLOWED_SPORTS].join(", ")}`,
      },
      { status: 400 },
    );
  }

  const rawMarkets = searchParams.get("markets") || "spreads,totals,h2h";
  const markets = rawMarkets
    .split(",")
    .filter((m) => ALLOWED_MARKETS.has(m))
    .join(",");
  if (!markets) {
    return NextResponse.json(
      { error: "No valid markets specified" },
      { status: 400 },
    );
  }

  const cacheKey = `${sport}:${markets}`;
  evictStale();
  const cached = cachedData.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data);
  }

  try {
    const url = new URL(`/v4/sports/${sport}/odds`, ODDS_API_BASE);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", markets);
    url.searchParams.set("oddsFormat", "decimal");
    // Only fetch upcoming games — live/started games can't be used for signals
    // The Odds API rejects milliseconds in ISO dates (422), so strip them
    url.searchParams.set("commenceTimeFrom", new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(`[odds-api] ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
      return NextResponse.json(
        { error: `Odds provider returned an error (${resp.status})` },
        { status: 502 },
      );
    }

    const data = await resp.json();
    cachedData.set(cacheKey, {
      data,
      expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    });

    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch odds from provider" },
      { status: 502 },
    );
  }
}
