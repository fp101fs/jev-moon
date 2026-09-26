import { describe, expect, test } from "bun:test";
import { breakout, meanReversion, randomPositions, resample, runGrid, runPositions, trend, type Bars } from "../src/candles";

const bars = (closes: number[], step = 60_000): Bars => ({
  t: Float64Array.from(closes.map((_, i) => i * step)),
  o: Float64Array.from(closes.map((c, i) => i ? closes[i - 1]! : c)),
  h: Float64Array.from(closes.map((c, i) => Math.max(c, i ? closes[i - 1]! : c))),
  l: Float64Array.from(closes.map((c, i) => Math.min(c, i ? closes[i - 1]! : c))),
  c: Float64Array.from(closes),
});

describe("candle execution", () => {
  test("fills at the next bar's open, so a signal can't capture its own bar's move", () => {
    const b = bars([100, 110, 121]);
    const r = runPositions(b, Uint8Array.from([0, 1, 1]), 0, 1, 3);
    expect(r.ret).toBeCloseTo(0.1); // long from the open of bar 2 (110) to its close (121); bar 1's jump is missed
  });
  test("charges cost on entry and exit", () => {
    const b = bars([100, 100, 100, 100]);
    const r = runPositions(b, Uint8Array.from([1, 1, 0, 0]), 50, 1, 4);
    expect(r.trades).toBe(1);
    expect(r.ret).toBeCloseTo((1 - 0.005) * (1 - 0.005) - 1);
    expect(r.wins).toBe(0);
  });
  test("closes an open position at the end of the window", () => {
    const r = runPositions(bars([100, 100, 120]), Uint8Array.from([1, 1, 1]), 0, 1, 3);
    expect(r.trades).toBe(1);
    expect(r.ret).toBeCloseTo(0.2);
  });
  test("random baseline keeps trade count and holding lengths", () => {
    let seed = 1; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pos = randomPositions(200, 10, 190, [5, 7, 3], rng);
    const r = runPositions(bars(Array.from({ length: 200 }, () => 100)), pos, 0, 10, 190);
    expect(r.holds.reduce((a, b) => a + b, 0)).toBe(15);
  });
  test("resamples to clock-aligned bars", () => {
    const r = resample(bars([1, 2, 3, 4, 5, 6]), 3);
    expect([...r.o]).toEqual([1, 3]); expect([...r.c]).toEqual([3, 6]); expect([...r.h]).toEqual([3, 6]);
  });
});

describe("signals", () => {
  test("trend is long only while the fast EMA is above the slow", () => {
    const pos = trend(2, 4)(bars([...Array(10).fill(100), ...Array.from({ length: 10 }, (_, i) => 101 + i)]));
    expect(pos[9]).toBe(0); expect(pos[19]).toBe(1);
  });
  test("mean reversion buys a sharp drop and exits at the mean", () => {
    const pos = meanReversion(5, 1.5)(bars([100, 100, 100, 100, 100, 90, 95, 101]));
    expect(pos[5]).toBe(1); expect(pos[7]).toBe(0);
  });
  test("breakout buys a new high", () => {
    const pos = breakout(4)(bars([100, 101, 100, 101, 100, 105]));
    expect(pos[5]).toBe(1);
  });
  test("grid buys a dip and sells the bounce, net of maker fees", () => {
    const r = runGrid(bars([100, 98, 100]), 0.02, 2, 10);
    expect(r.trades).toBe(1);
    expect(r.ret).toBeGreaterThan(0);
  });
});
