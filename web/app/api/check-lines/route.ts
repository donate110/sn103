import { NextRequest, NextResponse } from "next/server";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

/**
 * Server-side line availability check using the platform's Odds API key.
 *
 * POST /api/check-lines
 * Body: { lines: CandidateLine[] }
 *
 * This is a fallback for when all miners have exhausted their Odds API
 * quotas and return 0 available lines. Uses the same matching logic as
 * the miner checker but with the platform's own API key.
 */

const ODDS_API_BASE = "https://api.the-odds-api.com";

interface CandidateLine {
  index: number;
  sport: string;
  event_id: string;
  home_team: string;
  away_team: string;
  market: string;
  line: number | null;
  side: string;
}

interface BookmakerAvailability {
  bookmaker: string;
  odds: number;
}

interface LineResult {
  index: number;
  available: boolean;
  bookmakers: BookmakerAvailability[];
  unavailable_reason?: string;
}

// Map sport display names back to Odds API keys
const SPORT_KEY_MAP: Record<string, string> = {
  basketball_nba: "basketball_nba",
  americanfootball_nfl: "americanfootball_nfl",
  baseball_mlb: "baseball_mlb",
  icehockey_nhl: "icehockey_nhl",
  soccer_epl: "soccer_epl",
  soccer_usa_mls: "soccer_usa_mls",
  basketball_ncaab: "basketball_ncaab",
  americanfootball_ncaaf: "americanfootball_ncaaf",
  soccer_spain_la_liga: "soccer_spain_la_liga",
  soccer_germany_bundesliga: "soccer_germany_bundesliga",
  soccer_italy_serie_a: "soccer_italy_serie_a",
  soccer_france_ligue_one: "soccer_france_ligue_one",
  soccer_uefa_champs_league: "soccer_uefa_champs_league",
  mma_mixed_martial_arts: "mma_mixed_martial_arts",
};

function normalizeTeam(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sideMatches(side: string, outcomeName: string): boolean {
  const normSide = normalizeTeam(side);
  const normOutcome = normalizeTeam(outcomeName);
  // Exact match
  if (normSide === normOutcome) return true;
  // Side contains outcome name or vice versa
  if (normSide.includes(normOutcome) || normOutcome.includes(normSide)) return true;
  // Over/Under matching
  if ((normSide.startsWith("over") && normOutcome.startsWith("over")) ||
      (normSide.startsWith("under") && normOutcome.startsWith("under"))) {
    return true;
  }
  return false;
}

function lineMatches(candidateLine: number | null, point: number | null | undefined, market: string): boolean {
  if (market === "h2h") return true; // Moneyline has no line value
  if (candidateLine === null || point === null || point === undefined) return candidateLine === null && (point === null || point === undefined);
  return Math.abs(candidateLine - point) < 0.01;
}

export async function POST(request: NextRequest) {
  if (isRateLimited("check-lines", getIp(request), 10)) {
    return rateLimitResponse();
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Odds API key not configured" },
      { status: 503 },
    );
  }

  let body: { lines: CandidateLine[] };
  try {
    body = await request.json();
    if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > 20) {
      return NextResponse.json(
        { error: "Invalid lines array (1-20 items)" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const start = Date.now();

  // Group lines by sport
  const sportGroups = new Map<string, CandidateLine[]>();
  for (const line of body.lines) {
    const sport = SPORT_KEY_MAP[line.sport] || line.sport;
    if (!sportGroups.has(sport)) sportGroups.set(sport, []);
    sportGroups.get(sport)!.push(line);
  }

  // Fetch odds for each sport
  const sportEvents = new Map<string, Record<string, unknown>[]>();
  const fetchErrors: string[] = [];

  await Promise.all(
    [...sportGroups.keys()].map(async (sport) => {
      const marketsNeeded = new Set(
        sportGroups.get(sport)!.map((l) => l.market),
      );
      const marketsStr = [...marketsNeeded].join(",");

      try {
        const url = new URL(`/v4/sports/${sport}/odds`, ODDS_API_BASE);
        url.searchParams.set("apiKey", apiKey);
        url.searchParams.set("regions", "us");
        url.searchParams.set("markets", marketsStr);
        url.searchParams.set("oddsFormat", "decimal");

        const resp = await fetch(url.toString(), { cache: "no-store" });
        if (!resp.ok) {
          fetchErrors.push(`${sport}: HTTP ${resp.status}`);
          return;
        }
        const events = await resp.json();
        // Filter out started games
        const now = new Date();
        const filtered = (events as Record<string, unknown>[]).filter((ev) => {
          const ct = ev.commence_time as string | undefined;
          if (!ct) return true;
          try {
            return new Date(ct) > now;
          } catch {
            return true;
          }
        });
        sportEvents.set(sport, filtered);
      } catch (e) {
        fetchErrors.push(`${sport}: ${String(e).slice(0, 100)}`);
      }
    }),
  );

  // Check each line against fetched odds
  const results: LineResult[] = [];
  for (const line of body.lines) {
    const sport = SPORT_KEY_MAP[line.sport] || line.sport;
    const events = sportEvents.get(sport) || [];
    const bookmakers: BookmakerAvailability[] = [];
    let unavailable_reason: string | undefined;

    // Find matching event
    const matchingEvent = events.find((ev) => {
      const evId = ev.id as string;
      if (evId === line.event_id) return true;
      // Fallback: match by team names
      const home = normalizeTeam(String(ev.home_team || ""));
      const away = normalizeTeam(String(ev.away_team || ""));
      return (
        (home === normalizeTeam(line.home_team) && away === normalizeTeam(line.away_team)) ||
        (home === normalizeTeam(line.away_team) && away === normalizeTeam(line.home_team))
      );
    });

    if (!matchingEvent) {
      unavailable_reason = events.length === 0 ? "no_data" : "game_started";
      console.log(`[check-lines] line ${line.index}: no matching event (${unavailable_reason}), event_id=${line.event_id}, teams=${line.home_team} vs ${line.away_team}, events_count=${events.length}`);
      results.push({ index: line.index, available: false, bookmakers: [], unavailable_reason });
      continue;
    }

    // Check commence_time
    const ct = matchingEvent.commence_time as string | undefined;
    if (ct) {
      try {
        if (new Date(ct) <= new Date()) {
          results.push({ index: line.index, available: false, bookmakers: [], unavailable_reason: "game_started" });
          continue;
        }
      } catch { /* ignore parse errors */ }
    }

    // Search bookmakers for matching market/side/line
    const eventBookmakers = matchingEvent.bookmakers as Array<{
      key: string;
      title: string;
      markets: Array<{
        key: string;
        outcomes: Array<{ name: string; price: number; point?: number }>;
      }>;
    }> | undefined;

    if (eventBookmakers) {
      for (const bm of eventBookmakers) {
        for (const market of bm.markets || []) {
          if (market.key !== line.market) continue;
          for (const outcome of market.outcomes || []) {
            if (sideMatches(line.side, outcome.name) && lineMatches(line.line, outcome.point, line.market)) {
              if (!bookmakers.find((b) => b.bookmaker === bm.key)) {
                bookmakers.push({ bookmaker: bm.key, odds: outcome.price });
              }
            }
          }
        }
      }
    }

    if (bookmakers.length === 0) {
      unavailable_reason = "market_unavailable";
      const marketsAvail = (matchingEvent.bookmakers as Array<{ markets?: Array<{ key: string }> }> || [])
        .flatMap((bm) => (bm.markets || []).map((m) => m.key));
      console.log(`[check-lines] line ${line.index}: event found but no matching bookmaker, market=${line.market}, side=${line.side}, available_markets=[${[...new Set(marketsAvail)]}]`);
    }

    results.push({
      index: line.index,
      available: bookmakers.length > 0,
      bookmakers,
      unavailable_reason: bookmakers.length > 0 ? undefined : unavailable_reason,
    });
  }

  const available_indices = results
    .filter((r) => r.available)
    .map((r) => r.index);

  return NextResponse.json({
    results,
    available_indices,
    response_time_ms: Date.now() - start,
    source: "platform",
    api_error: fetchErrors.length > 0 && available_indices.length === 0
      ? fetchErrors.join("; ")
      : undefined,
  });
}
