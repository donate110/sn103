import { NextResponse } from "next/server";

/**
 * GET /api/sports
 *
 * Returns the list of supported sports with their display names and keys.
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
  { key: "soccer_spain_la_liga", name: "La Liga", category: "Soccer" },
  { key: "soccer_germany_bundesliga", name: "Bundesliga", category: "Soccer" },
  { key: "soccer_italy_serie_a", name: "Serie A", category: "Soccer" },
  { key: "soccer_france_ligue_one", name: "Ligue 1", category: "Soccer" },
  { key: "soccer_uefa_champs_league", name: "Champions League", category: "Soccer" },
  { key: "mma_mixed_martial_arts", name: "MMA", category: "Combat" },
  { key: "tennis_atp_french_open", name: "French Open", category: "Tennis" },
] as const;

export async function GET() {
  return NextResponse.json({
    sports: SPORTS,
    total: SPORTS.length,
  });
}
