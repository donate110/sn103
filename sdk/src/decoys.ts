/**
 * Decoy generation for Djinn signals.
 *
 * Generates 9 plausible decoy lines to accompany the real pick.
 * The SDK consumer provides available betting lines; this module
 * selects and shuffles them to create indistinguishable decoys.
 *
 * SECURITY: Decoys must be generated CLIENT-SIDE. Never use
 * server-provided decoys, as the server could identify the real
 * pick by exclusion.
 */

export interface DecoyConfig {
  /** The real pick as a structured line object */
  realPick: {
    event_id: string;
    market: string;
    pick: string;
    odds: number;
    bookmaker: string;
    [key: string]: unknown;
  };
  /** All available betting lines from the odds API (same sport) */
  availableLines: {
    event_id: string;
    market: string;
    pick: string;
    odds: number;
    bookmaker: string;
    [key: string]: unknown;
  }[];
  /** Number of decoys to generate (default: 9) */
  count?: number;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function lineKey(line: { event_id: string; market: string; pick: string }): string {
  return `${line.event_id}:${line.market}:${line.pick}`;
}

/**
 * Generate decoy lines from available odds data.
 *
 * Selection priority:
 * 1. Different game, same market (strongest camouflage)
 * 2. Same game, different market
 * 3. Different game, different market
 *
 * Returns exactly `count` decoy lines if enough are available.
 * Falls back to duplicating with randomized odds if insufficient data.
 */
export function generateDecoys(config: DecoyConfig): typeof config.availableLines {
  const { realPick, availableLines, count = 9 } = config;
  const used = new Set<string>();
  used.add(lineKey(realPick));
  const decoys: typeof availableLines = [];

  // Tier 1: Different game, same market
  const tier1 = shuffle(
    availableLines.filter(
      (l) => l.event_id !== realPick.event_id && l.market === realPick.market,
    ),
  );
  for (const line of tier1) {
    if (decoys.length >= count) break;
    const key = lineKey(line);
    if (used.has(key)) continue;
    used.add(key);
    decoys.push(line);
  }

  // Tier 2: Same game, different market
  if (decoys.length < count) {
    const tier2 = shuffle(
      availableLines.filter(
        (l) => l.event_id === realPick.event_id && l.market !== realPick.market,
      ),
    );
    for (const line of tier2) {
      if (decoys.length >= count) break;
      const key = lineKey(line);
      if (used.has(key)) continue;
      used.add(key);
      decoys.push(line);
    }
  }

  // Tier 3: Different game, different market
  if (decoys.length < count) {
    const tier3 = shuffle(
      availableLines.filter(
        (l) => l.event_id !== realPick.event_id && l.market !== realPick.market,
      ),
    );
    for (const line of tier3) {
      if (decoys.length >= count) break;
      const key = lineKey(line);
      if (used.has(key)) continue;
      used.add(key);
      decoys.push(line);
    }
  }

  return decoys;
}
