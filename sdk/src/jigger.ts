/**
 * Jigger (perturb) odds on decoy lines to mask the genius's price adjustment.
 * Only the odds/price field is modified. Spread values, totals, sides, and
 * team names are left unchanged so outcome evaluation remains correct.
 */

/** Convert American odds to decimal */
function americanToDecimal(american: number): number {
  if (american > 0) return american / 100 + 1;
  return 100 / Math.abs(american) + 1;
}

/** Convert decimal odds to American */
function decimalToAmerican(decimal: number): number {
  if (decimal >= 2.0) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

/** Check if a sport uses decimal odds (soccer) vs American odds */
function usesDecimalOdds(sport: string): boolean {
  return sport.startsWith("soccer_");
}

export interface JiggerConfig {
  /** The genius's price delta from market (e.g., if market was 1.91 and genius set 1.75, delta = -0.16) */
  delta: number;
  /** Whether the sport uses decimal odds */
  isDecimal: boolean;
}

/**
 * Apply a uniform odds delta to a structured line's price field.
 * The line is modified in place and returned.
 */
export function jiggerLineOdds<T extends { price?: number }>(
  line: T,
  config: JiggerConfig,
): T {
  if (line.price === undefined || line.price === null) return line;

  if (config.isDecimal) {
    // Decimal odds: apply delta directly (e.g., 1.91 + (-0.16) = 1.75)
    line.price = Math.max(1.01, +(line.price + config.delta).toFixed(4));
  } else {
    // American odds: convert to decimal, apply delta, convert back
    const decimal = americanToDecimal(line.price);
    const adjusted = Math.max(1.01, decimal + config.delta);
    line.price = decimalToAmerican(adjusted);
  }

  return line;
}

/**
 * Compute the odds delta between the genius's signal price and market price.
 */
export function computeOddsDelta(
  marketPrice: number,
  signalPrice: number,
  isDecimal: boolean,
): number {
  if (isDecimal) {
    return signalPrice - marketPrice;
  }
  // For American odds, work in decimal space for consistency
  return americanToDecimal(signalPrice) - americanToDecimal(marketPrice);
}
