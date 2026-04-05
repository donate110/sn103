import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/odds/alt?sport=basketball_nba&event_id=abc123
 *
 * Fetches alternate spreads and totals for a specific event.
 * Uses the per-event Odds API endpoint which supports alt markets.
 */

const ODDS_API_BASE = "https://api.the-odds-api.com";

export async function GET(request: NextRequest) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Odds API key not configured" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");
  const eventId = searchParams.get("event_id");

  if (!sport || !eventId) {
    return NextResponse.json(
      { error: "sport and event_id required" },
      { status: 400 },
    );
  }

  try {
    const url = new URL(
      `/v4/sports/${sport}/events/${eventId}/odds`,
      ODDS_API_BASE,
    );
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "alternate_spreads,alternate_totals");
    url.searchParams.set("oddsFormat", "decimal");

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `Odds provider error (${resp.status})` },
        { status: 502 },
      );
    }

    const data = await resp.json();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch alt lines" },
      { status: 502 },
    );
  }
}
