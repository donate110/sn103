import { describe, it, expect } from "vitest";
import { jiggerLineOdds, computeOddsDelta } from "./jigger";

describe("jiggerLineOdds", () => {
  it("applies decimal delta", () => {
    const line = { price: 1.91 };
    jiggerLineOdds(line, { delta: -0.16, isDecimal: true });
    expect(line.price).toBeCloseTo(1.75, 2);
  });

  it("applies American delta via decimal conversion", () => {
    const line = { price: -110 };
    const delta = computeOddsDelta(-110, -130, false);
    jiggerLineOdds(line, { delta, isDecimal: false });
    // -110 in decimal is 1.909, -130 is 1.769, delta ~ -0.14
    // Applying delta to -110 should give approximately -130
    expect(line.price).toBe(-130);
  });

  it("clamps to minimum 1.01 decimal", () => {
    const line = { price: 1.05 };
    jiggerLineOdds(line, { delta: -0.10, isDecimal: true });
    expect(line.price).toBeGreaterThanOrEqual(1.01);
  });

  it("skips lines without price", () => {
    const line = { price: undefined };
    const result = jiggerLineOdds(line, { delta: -0.16, isDecimal: true });
    expect(result.price).toBeUndefined();
  });
});

describe("computeOddsDelta", () => {
  it("computes decimal delta", () => {
    expect(computeOddsDelta(1.91, 1.75, true)).toBeCloseTo(-0.16, 2);
  });

  it("computes American delta in decimal space", () => {
    const delta = computeOddsDelta(-110, -130, false);
    expect(delta).toBeLessThan(0);
  });
});
