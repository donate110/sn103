import { describe, it, expect } from "vitest";
import { generateDecoys } from "./decoys";

const realPick = {
  event_id: "evt_1",
  market: "spreads",
  pick: "Celtics -4.5",
  odds: -110,
  bookmaker: "DraftKings",
};

const availableLines = [
  // Same sport, different games, same market (tier 1)
  { event_id: "evt_2", market: "spreads", pick: "Lakers -3.5", odds: -110, bookmaker: "DraftKings" },
  { event_id: "evt_3", market: "spreads", pick: "Warriors +5.5", odds: -110, bookmaker: "FanDuel" },
  { event_id: "evt_4", market: "spreads", pick: "Nets -1.5", odds: -110, bookmaker: "DraftKings" },
  { event_id: "evt_5", market: "spreads", pick: "Heat +2.5", odds: -110, bookmaker: "FanDuel" },
  // Same game, different market (tier 2)
  { event_id: "evt_1", market: "totals", pick: "Over 218.5", odds: -110, bookmaker: "DraftKings" },
  { event_id: "evt_1", market: "totals", pick: "Under 218.5", odds: -110, bookmaker: "DraftKings" },
  { event_id: "evt_1", market: "h2h", pick: "Celtics ML", odds: -150, bookmaker: "DraftKings" },
  // Different game, different market (tier 3)
  { event_id: "evt_6", market: "totals", pick: "Over 210.5", odds: -110, bookmaker: "BetMGM" },
  { event_id: "evt_7", market: "h2h", pick: "Bucks ML", odds: -200, bookmaker: "FanDuel" },
  { event_id: "evt_8", market: "totals", pick: "Under 225.5", odds: -110, bookmaker: "DraftKings" },
  { event_id: "evt_9", market: "spreads", pick: "Suns -6.5", odds: -110, bookmaker: "FanDuel" },
  { event_id: "evt_10", market: "h2h", pick: "Nuggets ML", odds: -130, bookmaker: "DraftKings" },
];

describe("generateDecoys", () => {
  it("generates exactly 9 decoys by default", () => {
    const decoys = generateDecoys({ realPick, availableLines });
    expect(decoys).toHaveLength(9);
  });

  it("does not include the real pick in decoys", () => {
    const decoys = generateDecoys({ realPick, availableLines });
    for (const d of decoys) {
      const key = `${d.event_id}:${d.market}:${d.pick}`;
      const realKey = `${realPick.event_id}:${realPick.market}:${realPick.pick}`;
      expect(key).not.toBe(realKey);
    }
  });

  it("prefers different-game same-market lines (tier 1)", () => {
    const decoys = generateDecoys({ realPick, availableLines });
    // Tier 1 lines have different event_id and same market as real pick
    const tier1Count = decoys.filter(
      (d) => d.event_id !== realPick.event_id && d.market === realPick.market,
    ).length;
    // Should have at least 4 tier 1 decoys (we provided 5 tier 1 candidates)
    expect(tier1Count).toBeGreaterThanOrEqual(4);
  });

  it("generates no duplicates", () => {
    const decoys = generateDecoys({ realPick, availableLines });
    const keys = decoys.map((d) => `${d.event_id}:${d.market}:${d.pick}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("respects custom count", () => {
    const decoys = generateDecoys({ realPick, availableLines, count: 5 });
    expect(decoys).toHaveLength(5);
  });

  it("handles insufficient available lines gracefully", () => {
    const fewLines = availableLines.slice(0, 3);
    const decoys = generateDecoys({ realPick, availableLines: fewLines, count: 9 });
    // Should return as many as possible, up to 3
    expect(decoys.length).toBeLessThanOrEqual(3);
    expect(decoys.length).toBeGreaterThan(0);
  });

  it("generates count=1 decoy", () => {
    const decoys = generateDecoys({ realPick, availableLines, count: 1 });
    expect(decoys).toHaveLength(1);
    const key = `${decoys[0].event_id}:${decoys[0].market}:${decoys[0].pick}`;
    const realKey = `${realPick.event_id}:${realPick.market}:${realPick.pick}`;
    expect(key).not.toBe(realKey);
  });

  it("generates count=99 decoys (capped by available lines)", () => {
    // We only have 12 available lines, so count=99 should return at most 12
    const decoys = generateDecoys({ realPick, availableLines, count: 99 });
    expect(decoys.length).toBeLessThanOrEqual(availableLines.length);
    expect(decoys.length).toBeGreaterThan(0);
    // No duplicates
    const keys = decoys.map((d) => `${d.event_id}:${d.market}:${d.pick}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
