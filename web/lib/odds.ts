/**
 * Types and helpers for The Odds API integration and structured line data.
 *
 * A "StructuredLine" is the JSON object stored in each decoyLines[] entry
 * on-chain. It carries all the data needed for the miner to verify availability
 * and for the buyer to construct CandidateLine objects.
 */

import type { CandidateLine } from "./api";

// ---------------------------------------------------------------------------
// Sport mapping
// ---------------------------------------------------------------------------

export interface SportOption {
  key: string; // The Odds API sport key
  label: string; // Display label
}

export interface SportGroup {
  label: string;
  sports: SportOption[];
}

export const SPORT_GROUPS: SportGroup[] = [
  {
    label: "US Major",
    sports: [
      { key: "basketball_nba", label: "NBA" },
      { key: "americanfootball_nfl", label: "NFL" },
      { key: "baseball_mlb", label: "MLB" },
      { key: "icehockey_nhl", label: "NHL" },
    ],
  },
  {
    label: "College",
    sports: [
      { key: "americanfootball_ncaaf", label: "NCAAF" },
      { key: "basketball_ncaab", label: "NCAAB" },
    ],
  },
  {
    label: "Soccer",
    sports: [
      { key: "soccer_epl", label: "EPL" },
      { key: "soccer_usa_mls", label: "MLS" },
    ],
  },
];

/** Flat list of all sports for convenience. */
export const SPORTS: SportOption[] = SPORT_GROUPS.flatMap((g) => g.sports);

// ---------------------------------------------------------------------------
// The Odds API response types
// ---------------------------------------------------------------------------

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface OddsMarket {
  key: string; // "spreads", "totals", "h2h"
  outcomes: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  title: string;
  markets: OddsMarket[];
}

export interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

// ---------------------------------------------------------------------------
// StructuredLine — the JSON payload stored in decoyLines[] on-chain
// ---------------------------------------------------------------------------

export interface StructuredLine {
  sport: string;
  event_id: string;
  home_team: string;
  away_team: string;
  market: string; // "spreads" | "totals" | "h2h"
  line: number | null; // point value (null for h2h)
  side: string; // team name or "Over"/"Under"
  price?: number; // decimal odds (e.g. 1.91); display-only, not part of signal secrecy
  commence_time?: string; // ISO 8601 game start time
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/** Convert decimal odds to American format for display. */
function toAmerican(decimal: number): string {
  if (decimal >= 2.0) return `+${Math.round((decimal - 1) * 100)}`;
  if (decimal > 1.0) return `${Math.round(-100 / (decimal - 1))}`;
  return "EVEN";
}

/** Format decimal odds for display — American (-110) or decimal (1.91). */
export function formatOdds(decimal: number, format: "american" | "decimal" = "american"): string {
  if (format === "decimal") return decimal.toFixed(2);
  return toAmerican(decimal);
}

/** Whether a sport conventionally uses decimal odds (non-US sports). */
export function usesDecimalOdds(sportKey: string): boolean {
  return sportKey.startsWith("soccer_") ||
    sportKey.startsWith("mma_") ||
    sportKey.startsWith("tennis_") ||
    sportKey.startsWith("golf_") ||
    sportKey.startsWith("boxing_");
}

/** Convert a StructuredLine into a human-readable display string. */
export function formatLine(line: StructuredLine, oddsFormat: "american" | "decimal" = "american"): string {
  const teams = abbreviateTeam(line.home_team) + " vs " + abbreviateTeam(line.away_team);
  const oddsStr = line.price ? ` (${formatOdds(line.price, oddsFormat)})` : "";
  switch (line.market) {
    case "spreads": {
      const spread = line.line != null ? (line.line > 0 ? `+${line.line}` : `${line.line}`) : "";
      return `${line.side} ${spread}${oddsStr} — ${teams}`;
    }
    case "totals": {
      const total = line.line != null ? `${line.line}` : "";
      return `${line.side} ${total}${oddsStr} — ${teams}`;
    }
    case "h2h":
      return `${line.side}${oddsStr} ML — ${teams}`;
    default:
      return `${line.side}${oddsStr} — ${teams}`;
  }
}

/** Abbreviate a team name for compact display. */
function abbreviateTeam(name: string): string {
  const parts = name.split(" ");
  if (parts.length <= 1) return name;
  // Use last word (usually nickname): "Los Angeles Lakers" -> "Lakers"
  return parts[parts.length - 1];
}

/** Serialize a StructuredLine to a JSON string for on-chain storage. */
export function serializeLine(line: StructuredLine): string {
  return JSON.stringify(line);
}

/** Parse a decoyLine string. Returns StructuredLine if valid JSON, null otherwise. */
export function parseLine(raw: string): StructuredLine | null {
  try {
    const obj = JSON.parse(raw);
    if (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.sport === "string" &&
      typeof obj.event_id === "string" &&
      typeof obj.home_team === "string" &&
      typeof obj.away_team === "string" &&
      typeof obj.market === "string" &&
      typeof obj.side === "string" &&
      (obj.line === null || (typeof obj.line === "number" && Number.isFinite(obj.line)))
    ) {
      return obj as StructuredLine;
    }
  } catch {
    // Not JSON — legacy raw string
  }
  return null;
}

/** Convert a StructuredLine + index to a CandidateLine for the miner check API. */
export function toCandidateLine(line: StructuredLine, index: number): CandidateLine {
  return {
    index,
    sport: line.sport,
    event_id: line.event_id,
    home_team: line.home_team,
    away_team: line.away_team,
    market: line.market,
    line: line.line,
    side: line.side,
  };
}

/**
 * Convert a raw decoyLine string to a CandidateLine.
 * Tries JSON first, falls back to legacy raw string format.
 */
export function decoyLineToCandidateLine(
  raw: string,
  index: number,
  fallbackSport: string,
  fallbackSignalId: string,
): CandidateLine {
  const parsed = parseLine(raw);
  if (parsed) return toCandidateLine(parsed, index);

  // Legacy fallback: raw string like "Lakers -3.5 (-110)"
  return {
    index,
    sport: fallbackSport.toLowerCase().replace(/\s/g, "_"),
    event_id: `signal_${fallbackSignalId}`,
    home_team: "TBD",
    away_team: "TBD",
    market: "spreads",
    line: null,
    side: raw,
  };
}

// ---------------------------------------------------------------------------
// Bet extraction — pull all possible bets from an event's bookmaker odds
// ---------------------------------------------------------------------------

export interface AvailableBet {
  event: OddsEvent;
  market: string;
  side: string;
  line: number | null;
  avgPrice: number;
  bookCount: number;
  minPrice: number;
  maxPrice: number;
  /** Bookmaker titles that offer this bet */
  books: string[];
}

/** Extract all unique bets from an event, using consensus odds across bookmakers. */
export function extractBets(event: OddsEvent): AvailableBet[] {
  const betMap = new Map<string, { prices: number[]; titles: string[]; bet: AvailableBet }>();

  for (const bk of event.bookmakers) {
    for (const mkt of bk.markets) {
      for (const outcome of mkt.outcomes) {
        const key = `${mkt.key}|${outcome.name}|${outcome.point ?? ""}`;
        const existing = betMap.get(key);
        if (existing) {
          existing.prices.push(outcome.price);
          if (!existing.titles.includes(bk.title)) {
            existing.titles.push(bk.title);
          }
        } else {
          betMap.set(key, {
            prices: [outcome.price],
            titles: [bk.title],
            bet: {
              event,
              market: mkt.key,
              side: outcome.name,
              line: outcome.point ?? null,
              avgPrice: outcome.price,
              bookCount: 1,
              minPrice: outcome.price,
              maxPrice: outcome.price,
              books: [],
            },
          });
        }
      }
    }
  }

  return [...betMap.values()].map(({ prices, titles, bet }) => ({
    ...bet,
    avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
    bookCount: prices.length,
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    books: titles,
  }));
}

/** Convert an AvailableBet into a StructuredLine. */
export function betToLine(bet: AvailableBet): StructuredLine {
  return {
    sport: bet.event.sport_key,
    event_id: bet.event.id,
    home_team: bet.event.home_team,
    away_team: bet.event.away_team,
    market: bet.market,
    line: bet.line,
    side: bet.side,
    price: bet.avgPrice,
    commence_time: bet.event.commence_time,
  };
}

// ---------------------------------------------------------------------------
// Decoy generation
// ---------------------------------------------------------------------------

/** Unique key for deduplication. */
function lineKey(l: StructuredLine): string {
  return `${l.event_id}|${l.market}|${l.side}|${l.line}`;
}

/** Generate plausible odds for synthetic decoy lines based on the real pick's market. */
function syntheticOdds(realPick: StructuredLine): number {
  // Standard vig odds: spreads/totals hover around -110 (1.909), ML varies widely
  const rng = new Uint32Array(1);
  crypto.getRandomValues(rng);
  const jitter = ((rng[0] % 20) - 10) / 100; // ±0.10
  if (realPick.market === "h2h") {
    // ML odds vary widely: -300 to +300 (1.33 to 4.0 decimal)
    const base = realPick.price ?? 1.91;
    return Math.max(1.1, base + jitter * 3);
  }
  // Spreads and totals: -115 to -105 range (1.87 to 1.95 decimal)
  return 1.91 + jitter;
}

/** Fisher-Yates shuffle using crypto.getRandomValues (does not mutate input). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  const rng = new Uint32Array(a.length);
  crypto.getRandomValues(rng);
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng[i] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate plausible decoy lines from available odds data.
 *
 * Strategy (prioritizes indistinguishability):
 * 1. Different games, same market — these are the strongest decoys because
 *    they look structurally identical to the real pick
 * 2. Same game, different market — plausible but buyer could notice clustering
 * 3. Different game, different market — weakest real-data decoys
 * 4. Synthetic variations — line adjustments on real events (NEVER uses
 *    modified event_ids to avoid information leakage)
 *
 * The algorithm fills as many slots as possible from tier 1 before falling
 * back, which means a spread pick will be surrounded by other spread picks
 * from different games — making it very hard to identify the real one.
 */
export function generateDecoys(
  realPick: StructuredLine,
  allEvents: OddsEvent[],
  count: number = 9,
): StructuredLine[] {
  const used = new Set<string>();
  used.add(lineKey(realPick));
  const decoys: StructuredLine[] = [];

  const allBets: AvailableBet[] = [];
  for (const ev of allEvents) {
    allBets.push(...extractBets(ev));
  }

  // Tier 1: Different game, same market (strongest camouflage)
  const tier1 = shuffle(
    allBets.filter(
      (b) => b.event.id !== realPick.event_id && b.market === realPick.market,
    ),
  );
  for (const bet of tier1) {
    if (decoys.length >= count) break;
    const line = betToLine(bet);
    const key = lineKey(line);
    if (used.has(key)) continue;
    used.add(key);
    decoys.push(line);
  }

  // Tier 2: Same game, different market
  if (decoys.length < count) {
    const tier2 = shuffle(
      allBets.filter(
        (b) => b.event.id === realPick.event_id && b.market !== realPick.market,
      ),
    );
    for (const bet of tier2) {
      if (decoys.length >= count) break;
      const line = betToLine(bet);
      const key = lineKey(line);
      if (used.has(key)) continue;
      used.add(key);
      decoys.push(line);
    }
  }

  // Tier 3: Different game, different market
  if (decoys.length < count) {
    const tier3 = shuffle(
      allBets.filter(
        (b) => b.event.id !== realPick.event_id && b.market !== realPick.market,
      ),
    );
    for (const bet of tier3) {
      if (decoys.length >= count) break;
      const line = betToLine(bet);
      const key = lineKey(line);
      if (used.has(key)) continue;
      used.add(key);
      decoys.push(line);
    }
  }

  // Tier 4: Synthetic variations on REAL events (no modified event_ids)
  // Pick random events and create plausible alternate lines
  if (decoys.length < count) {
    const otherEvents = shuffle(
      allEvents.filter((ev) => ev.id !== realPick.event_id),
    );
    const synthSources = otherEvents.length > 0 ? otherEvents : allEvents;
    const offsets = [0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5];

    for (const ev of synthSources) {
      if (decoys.length >= count) break;
      for (const offset of offsets) {
        if (decoys.length >= count) break;
        const synthLine: StructuredLine = {
          sport: ev.sport_key,
          event_id: ev.id, // Use REAL event id — no _synth suffix
          home_team: ev.home_team,
          away_team: ev.away_team,
          market: realPick.market,
          line: realPick.line != null ? realPick.line + offset : null,
          side: realPick.market === "totals"
            ? (offset > 0 ? "Over" : "Under")
            : (offset > 0 ? ev.away_team : ev.home_team),
          price: syntheticOdds(realPick),
        };
        const key = lineKey(synthLine);
        if (used.has(key)) continue;
        used.add(key);
        decoys.push(synthLine);
      }
    }
  }

  // Final fallback: line variations on the pick's own event
  if (decoys.length < count) {
    const fallbackOffsets = [0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 3, -3];
    const sides = realPick.market === "totals"
      ? ["Over", "Under"]
      : [realPick.home_team, realPick.away_team];
    for (const offset of fallbackOffsets) {
      if (decoys.length >= count) break;
      for (const side of sides) {
        if (decoys.length >= count) break;
        const synthLine: StructuredLine = {
          ...realPick,
          line: (realPick.line ?? 0) + offset,
          side,
          price: syntheticOdds(realPick),
        };
        const key = lineKey(synthLine);
        if (used.has(key)) continue;
        used.add(key);
        decoys.push(synthLine);
      }
    }
  }

  return decoys.slice(0, count);
}