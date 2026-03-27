import { NextResponse } from "next/server";

/**
 * GET /api/sports
 *
 * Returns the list of supported sports with their display names and keys.
 * Only includes sports that the validator network can actually settle
 * (must have an ESPN mapping for score resolution).
 * No authentication required.
 */

const SPORTS = [
  { key: "basketball_nba", name: "NBA", category: "Basketball" },
  { key: "basketball_ncaab", name: "NCAA Basketball", category: "Basketball" },
  { key: "americanfootball_nfl", name: "NFL", category: "Football" },
  { key: "americanfootball_ncaaf", name: "NCAA Football", category: "Football" },
  { key: "baseball_mlb", name: "MLB", category: "Baseball" },
  { key: "icehockey_nhl", name: "NHL", category: "Hockey" },
  { key: "soccer_epl", name: "Premier League", category: "Soccer" },
  { key: "soccer_usa_mls", name: "MLS", category: "Soccer" },
] as const;

export async function GET() {
  return NextResponse.json({
    sports: SPORTS,
    total: SPORTS.length,
  });
}
