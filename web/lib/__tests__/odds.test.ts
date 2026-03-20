import { describe, it, expect } from "vitest";
import {
  formatLine,
  formatOdds,
  usesDecimalOdds,
  parseLine,
  serializeLine,
  toCandidateLine,
  decoyLineToCandidateLine,
  extractBets,
  betToLine,
  generateDecoys,
  SPORTS,
  SPORT_GROUPS,
  type StructuredLine,
  type OddsEvent,
} from "../odds";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const LAKERS_LINE: StructuredLine = {
  sport: "basketball_nba",
  event_id: "abc123",
  home_team: "Los Angeles Lakers",
  away_team: "Boston Celtics",
  market: "spreads",
  line: -3.5,
  side: "Los Angeles Lakers",
};

const OVER_LINE: StructuredLine = {
  sport: "basketball_nba",
  event_id: "abc123",
  home_team: "Los Angeles Lakers",
  away_team: "Boston Celtics",
  market: "totals",
  line: 218.5,
  side: "Over",
};

const ML_LINE: StructuredLine = {
  sport: "basketball_nba",
  event_id: "abc123",
  home_team: "Los Angeles Lakers",
  away_team: "Boston Celtics",
  market: "h2h",
  line: null,
  side: "Los Angeles Lakers",
};

function makeEvent(overrides: Partial<OddsEvent> = {}): OddsEvent {
  return {
    id: "event1",
    sport_key: "basketball_nba",
    sport_title: "NBA",
    commence_time: "2026-02-17T00:30:00Z",
    home_team: "Los Angeles Lakers",
    away_team: "Boston Celtics",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          {
            key: "spreads",
            outcomes: [
              { name: "Los Angeles Lakers", price: 1.91, point: -3.5 },
              { name: "Boston Celtics", price: 1.91, point: 3.5 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", price: 1.91, point: 218.5 },
              { name: "Under", price: 1.91, point: 218.5 },
            ],
          },
          {
            key: "h2h",
            outcomes: [
              { name: "Los Angeles Lakers", price: 1.67 },
              { name: "Boston Celtics", price: 2.2 },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeEvents(count: number): OddsEvent[] {
  const teams = [
    ["Los Angeles Lakers", "Boston Celtics"],
    ["Golden State Warriors", "Miami Heat"],
    ["Milwaukee Bucks", "Denver Nuggets"],
    ["Phoenix Suns", "Dallas Mavericks"],
    ["Philadelphia 76ers", "New York Knicks"],
    ["Chicago Bulls", "Brooklyn Nets"],
  ];
  return Array.from({ length: count }, (_, i) => {
    const [home, away] = teams[i % teams.length];
    return makeEvent({
      id: `event${i + 1}`,
      home_team: home,
      away_team: away,
    });
  });
}

// ---------------------------------------------------------------------------
// formatLine
// ---------------------------------------------------------------------------

describe("formatLine", () => {
  it("formats spread line", () => {
    expect(formatLine(LAKERS_LINE)).toBe("Los Angeles Lakers -3.5 — Lakers vs Celtics");
  });

  it("formats positive spread", () => {
    expect(
      formatLine({ ...LAKERS_LINE, side: "Boston Celtics", line: 3.5 }),
    ).toBe("Boston Celtics +3.5 — Lakers vs Celtics");
  });

  it("formats totals line", () => {
    expect(formatLine(OVER_LINE)).toBe("Over 218.5 — Lakers vs Celtics");
  });

  it("formats moneyline", () => {
    expect(formatLine(ML_LINE)).toBe("Los Angeles Lakers ML — Lakers vs Celtics");
  });

  it("formats with decimal odds", () => {
    expect(
      formatLine({ ...LAKERS_LINE, price: 1.91 }, "decimal"),
    ).toBe("Los Angeles Lakers -3.5 (1.91) — Lakers vs Celtics");
  });

  it("formats with american odds", () => {
    expect(
      formatLine({ ...LAKERS_LINE, price: 1.91 }, "american"),
    ).toBe("Los Angeles Lakers -3.5 (-110) — Lakers vs Celtics");
  });
});

// ---------------------------------------------------------------------------
// formatOdds
// ---------------------------------------------------------------------------

describe("formatOdds", () => {
  it("formats as American by default", () => {
    expect(formatOdds(1.91)).toBe("-110");
    expect(formatOdds(2.5)).toBe("+150");
  });

  it("formats as decimal", () => {
    expect(formatOdds(1.91, "decimal")).toBe("1.91");
    expect(formatOdds(2.5, "decimal")).toBe("2.50");
  });

  it("handles even odds", () => {
    expect(formatOdds(1.0, "american")).toBe("EVEN");
    expect(formatOdds(1.0, "decimal")).toBe("1.00");
  });
});

// ---------------------------------------------------------------------------
// usesDecimalOdds
// ---------------------------------------------------------------------------

describe("usesDecimalOdds", () => {
  it("returns false for US sports", () => {
    expect(usesDecimalOdds("basketball_nba")).toBe(false);
    expect(usesDecimalOdds("americanfootball_nfl")).toBe(false);
    expect(usesDecimalOdds("baseball_mlb")).toBe(false);
    expect(usesDecimalOdds("icehockey_nhl")).toBe(false);
  });

  it("returns true for soccer", () => {
    expect(usesDecimalOdds("soccer_epl")).toBe(true);
    expect(usesDecimalOdds("soccer_spain_la_liga")).toBe(true);
    expect(usesDecimalOdds("soccer_usa_mls")).toBe(true);
  });

  it("returns true for non-US sports", () => {
    expect(usesDecimalOdds("mma_mixed_martial_arts")).toBe(true);
    expect(usesDecimalOdds("tennis_atp_french_open")).toBe(true);
    expect(usesDecimalOdds("golf_pga_championship_winner")).toBe(true);
    expect(usesDecimalOdds("boxing_boxing")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseLine / serializeLine round-trip
// ---------------------------------------------------------------------------

describe("parseLine", () => {
  it("parses a valid JSON structured line", () => {
    const json = serializeLine(LAKERS_LINE);
    const parsed = parseLine(json);
    expect(parsed).toEqual(LAKERS_LINE);
  });

  it("returns null for a raw string", () => {
    expect(parseLine("Lakers -3.5 (-110)")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseLine("{invalid")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(parseLine(JSON.stringify({ sport: "nba" }))).toBeNull();
  });

  it("returns null when line is a boolean", () => {
    const raw = JSON.stringify({ ...LAKERS_LINE, line: true });
    expect(parseLine(raw)).toBeNull();
  });

  it("accepts null line (h2h market)", () => {
    const parsed = parseLine(serializeLine(ML_LINE));
    expect(parsed).toEqual(ML_LINE);
    expect(parsed!.line).toBeNull();
  });

  it("returns null when line is a string", () => {
    const raw = JSON.stringify({ ...LAKERS_LINE, line: "bad" });
    expect(parseLine(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toCandidateLine
// ---------------------------------------------------------------------------

describe("toCandidateLine", () => {
  it("converts with correct index", () => {
    const candidate = toCandidateLine(LAKERS_LINE, 3);
    expect(candidate.index).toBe(3);
    expect(candidate.sport).toBe("basketball_nba");
    expect(candidate.event_id).toBe("abc123");
    expect(candidate.home_team).toBe("Los Angeles Lakers");
    expect(candidate.away_team).toBe("Boston Celtics");
    expect(candidate.market).toBe("spreads");
    expect(candidate.line).toBe(-3.5);
    expect(candidate.side).toBe("Los Angeles Lakers");
  });
});

// ---------------------------------------------------------------------------
// decoyLineToCandidateLine
// ---------------------------------------------------------------------------

describe("decoyLineToCandidateLine", () => {
  it("parses structured JSON line", () => {
    const json = serializeLine(LAKERS_LINE);
    const candidate = decoyLineToCandidateLine(json, 1, "NBA", "signal123");
    expect(candidate.sport).toBe("basketball_nba");
    expect(candidate.event_id).toBe("abc123");
    expect(candidate.line).toBe(-3.5);
  });

  it("falls back for raw string", () => {
    const candidate = decoyLineToCandidateLine(
      "Lakers -3.5 (-110)",
      2,
      "NBA",
      "signal456",
    );
    expect(candidate.index).toBe(2);
    expect(candidate.sport).toBe("nba");
    expect(candidate.event_id).toBe("signal_signal456");
    expect(candidate.home_team).toBe("TBD");
    expect(candidate.side).toBe("Lakers -3.5 (-110)");
  });
});

// ---------------------------------------------------------------------------
// extractBets
// ---------------------------------------------------------------------------

describe("extractBets", () => {
  it("extracts all bets from an event", () => {
    const event = makeEvent();
    const bets = extractBets(event);
    // 2 spreads + 2 totals + 2 h2h = 6
    expect(bets.length).toBe(6);
  });

  it("averages prices across multiple bookmakers", () => {
    const event = makeEvent({
      bookmakers: [
        {
          key: "dk",
          title: "DK",
          markets: [
            {
              key: "h2h",
              outcomes: [{ name: "Lakers", price: 1.80 }],
            },
          ],
        },
        {
          key: "fd",
          title: "FD",
          markets: [
            {
              key: "h2h",
              outcomes: [{ name: "Lakers", price: 2.00 }],
            },
          ],
        },
      ],
    });
    const bets = extractBets(event);
    const lakersBet = bets.find((b) => b.side === "Lakers");
    expect(lakersBet).toBeDefined();
    expect(lakersBet!.avgPrice).toBeCloseTo(1.9);
  });

  it("populates bookCount, minPrice, maxPrice", () => {
    const event = makeEvent({
      bookmakers: [
        {
          key: "dk",
          title: "DK",
          markets: [
            { key: "h2h", outcomes: [{ name: "Lakers", price: 1.70 }] },
          ],
        },
        {
          key: "fd",
          title: "FD",
          markets: [
            { key: "h2h", outcomes: [{ name: "Lakers", price: 2.10 }] },
          ],
        },
        {
          key: "mgm",
          title: "MGM",
          markets: [
            { key: "h2h", outcomes: [{ name: "Lakers", price: 1.85 }] },
          ],
        },
      ],
    });
    const bets = extractBets(event);
    const lakersBet = bets.find((b) => b.side === "Lakers")!;
    expect(lakersBet.bookCount).toBe(3);
    expect(lakersBet.minPrice).toBeCloseTo(1.70);
    expect(lakersBet.maxPrice).toBeCloseTo(2.10);
  });

  it("sets bookCount=1 and min=max for single bookmaker", () => {
    const event = makeEvent();
    const bets = extractBets(event);
    for (const bet of bets) {
      expect(bet.bookCount).toBe(1);
      expect(bet.minPrice).toBe(bet.maxPrice);
    }
  });
});

// ---------------------------------------------------------------------------
// betToLine
// ---------------------------------------------------------------------------

describe("betToLine", () => {
  it("converts a bet to a structured line", () => {
    const event = makeEvent();
    const bets = extractBets(event);
    const spreadBet = bets.find(
      (b) => b.market === "spreads" && b.side === "Los Angeles Lakers",
    )!;
    const line = betToLine(spreadBet);
    expect(line.sport).toBe("basketball_nba");
    expect(line.event_id).toBe("event1");
    expect(line.market).toBe("spreads");
    expect(line.line).toBe(-3.5);
    expect(line.side).toBe("Los Angeles Lakers");
  });
});

// ---------------------------------------------------------------------------
// generateDecoys
// ---------------------------------------------------------------------------

describe("generateDecoys", () => {
  it("generates exactly 9 decoys", () => {
    const events = makeEvents(5);
    const pick = betToLine(extractBets(events[0])[0]);
    const decoys = generateDecoys(pick, events, 9);
    expect(decoys.length).toBe(9);
  });

  it("does not include the real pick in decoys", () => {
    const events = makeEvents(5);
    const pick = betToLine(extractBets(events[0])[0]);
    const decoys = generateDecoys(pick, events, 9);
    const pickKey = `${pick.event_id}|${pick.market}|${pick.side}|${pick.line}`;
    for (const decoy of decoys) {
      const decoyKey = `${decoy.event_id}|${decoy.market}|${decoy.side}|${decoy.line}`;
      expect(decoyKey).not.toBe(pickKey);
    }
  });

  it("generates decoys even with only one event (uses synthetic)", () => {
    const events = [makeEvent()];
    const pick = betToLine(extractBets(events[0])[0]);
    const decoys = generateDecoys(pick, events, 9);
    expect(decoys.length).toBe(9);
  });

  it("generates decoys with no events (all synthetic)", () => {
    const decoys = generateDecoys(LAKERS_LINE, [], 9);
    expect(decoys.length).toBe(9);
  });

  it("all decoys have required fields", () => {
    const events = makeEvents(3);
    const pick = betToLine(extractBets(events[0])[0]);
    const decoys = generateDecoys(pick, events, 9);
    for (const d of decoys) {
      expect(d.sport).toBeDefined();
      expect(d.event_id).toBeDefined();
      expect(d.home_team).toBeDefined();
      expect(d.away_team).toBeDefined();
      expect(d.market).toBeDefined();
      expect(d.side).toBeDefined();
    }
  });

  it("prefers same-market decoys when enough events exist", () => {
    const events = makeEvents(6);
    const spreadBets = extractBets(events[0]).filter((b) => b.market === "spreads");
    const pick = betToLine(spreadBets[0]);
    const decoys = generateDecoys(pick, events, 9);
    const sameMarket = decoys.filter((d) => d.market === "spreads").length;
    // With 6 events * 2 spread bets each = 12 candidates, should fill most slots with spreads
    expect(sameMarket).toBeGreaterThanOrEqual(5);
  });

  it("never produces event_ids with _synth or _fill suffixes", () => {
    const events = [makeEvent()]; // minimal events forces synthetic generation
    const pick = betToLine(extractBets(events[0])[0]);
    const decoys = generateDecoys(pick, events, 9);
    for (const d of decoys) {
      expect(d.event_id).not.toContain("_synth");
      expect(d.event_id).not.toContain("_fill");
    }
  });

  it("generates decoys from empty events without crashing", () => {
    const decoys = generateDecoys(LAKERS_LINE, [], 9);
    expect(decoys.length).toBe(9);
    for (const d of decoys) {
      expect(d.event_id).not.toContain("_synth");
      expect(d.event_id).not.toContain("_fill");
    }
  });
});

// ---------------------------------------------------------------------------
// SPORT_GROUPS / SPORTS
// ---------------------------------------------------------------------------

describe("SPORT_GROUPS", () => {
  it("SPORTS flat list matches all groups combined", () => {
    const fromGroups = SPORT_GROUPS.flatMap((g) => g.sports);
    expect(SPORTS).toEqual(fromGroups);
  });

  it("has no duplicate sport keys", () => {
    const keys = SPORTS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes major US sports", () => {
    const keys = new Set(SPORTS.map((s) => s.key));
    expect(keys.has("basketball_nba")).toBe(true);
    expect(keys.has("americanfootball_nfl")).toBe(true);
    expect(keys.has("baseball_mlb")).toBe(true);
    expect(keys.has("icehockey_nhl")).toBe(true);
  });

  it("includes soccer leagues", () => {
    const soccerSports = SPORTS.filter((s) => s.key.startsWith("soccer_"));
    expect(soccerSports.length).toBeGreaterThanOrEqual(2);
  });
});
