import { describe, expect, test } from "bun:test";
import { CoinStrategy, DEFAULT_CONFIG, newCoinState } from "../src/strategy";

const bar = (t: number, o: number, h = o, l = o, c = o) => ({ t, o, h, l, c });
const cfg = { ...DEFAULT_CONFIG, mode: "grid" as const, makerBps: 0, takerBps: 0, regimeDays: 3, regimeBand: 0, trailingStop: 0, makerEntry: false, cashYieldApr: 0 };

describe("regime", () => {
  test("turns on after a close above the EMA and applies from the next bar", () => {
    const s = new CoinStrategy(cfg, newCoinState(100));
    s.onDailyClose(0, 100);
    expect(s.state.regimeOn).toBe(false);
    s.onDailyClose(1, 110);
    expect(s.state.regimeOn).toBe(true);
  });
  test("ignores a daily candle it has already seen", () => {
    const s = new CoinStrategy(cfg, newCoinState(100));
    s.onDailyClose(5, 100); s.onDailyClose(5, 200);
    expect(s.state.ema).toBe(100);
  });
  test("sells everything at the open when the regime turns off", () => {
    const s = new CoinStrategy({ ...cfg, mode: "hold", takerBps: 50 }, newCoinState(100));
    s.state.regimeOn = true;
    s.onBar(bar(0, 10));
    s.state.regimeOn = false;
    const [fill] = s.onBar(bar(1, 12));
    expect(fill!.kind).toBe("regime-off");
    expect(s.quantity).toBe(0);
    expect(s.state.cash).toBeCloseTo(100 * 0.995 * 1.2 * 0.995);
  });
});

describe("grid", () => {
  test("buys a slot on a spacing drop and sells it on the rebound, net of maker fees", () => {
    const s = new CoinStrategy({ ...cfg, spacing: 0.04, units: 10, makerBps: 22 }, newCoinState(1000));
    s.state.regimeOn = true;
    s.onBar(bar(0, 100));
    const [buy] = s.onBar(bar(1, 99, 99, 95.9, 96));
    expect(buy!.price).toBeCloseTo(96);
    const [sell] = s.onBar(bar(2, 99, 99.9, 99, 99.5));
    expect(sell!.price).toBeCloseTo(99.84);
    expect(s.equity(99.5)).toBeGreaterThan(1000);
  });
  test("never holds more than `units` slots", () => {
    const s = new CoinStrategy({ ...cfg, spacing: 0.01, units: 3 }, newCoinState(300));
    s.state.regimeOn = true;
    let p = 100;
    s.onBar(bar(0, p));
    for (let i = 1; i < 10; i++) { p *= 0.98; s.onBar(bar(i, p, p, p, p)); }
    expect(s.state.lots.length).toBe(3);
  });
  test("state round-trips through JSON, so the bot can resume after a restart", () => {
    const s = new CoinStrategy(cfg, newCoinState(100));
    s.state.regimeOn = true; s.onBar(bar(0, 100)); s.onBar(bar(1, 95, 95, 95, 95));
    const resumed = new CoinStrategy(cfg, JSON.parse(JSON.stringify(s.state)));
    expect(resumed.equity(95)).toBeCloseTo(s.equity(95));
  });
});

describe("trailing stop", () => {
  const stopCfg = { ...cfg, mode: "hold" as const, trailingStop: 0.1, regimeDays: 1000 };
  const onWith = (closes: number[]) => {
    const s = new CoinStrategy(stopCfg, newCoinState(100));
    s.onDailyClose(0, 50); // seed the EMA far below so the regime stays on
    closes.forEach((c, i) => s.onDailyClose(i + 1, c));
    return s;
  };
  test("fires after a 10% fall from the peak close, and sells at the next bar", () => {
    const s = onWith([100, 120, 107]);
    expect(s.allowed).toBe(false);
    s.state.lots = [1]; s.state.cash = 0;
    const [fill] = s.onBar(bar(10, 107));
    expect(fill!.kind).toBe("trailing-stop");
  });
  test("does not fire on a smaller pullback", () => {
    expect(onWith([100, 120, 109]).allowed).toBe(true);
  });
  test("re-enters only on a close above the old peak", () => {
    expect(onWith([100, 120, 107, 119]).allowed).toBe(false);
    expect(onWith([100, 120, 107, 121]).allowed).toBe(true);
  });
});

import { DipSleeve, newDipState } from "../src/strategy";
describe("dip sleeve", () => {
  const dipCfg = { drop: 0.05, windowMin: 60, holdMin: 3, takerBps: 0, crashSlipBps: 100 };
  const m = 60_000;
  test("buys the bar after a 5% drop from the prior-hour high, with crash slippage, and sells after the hold", () => {
    const d = new DipSleeve(dipCfg, newDipState(100));
    d.onBar(bar(0, 100, 100, 100, 100), true);
    expect(d.onBar(bar(1 * m, 99, 99, 94, 95), true)).toEqual([]);
    const [buy] = d.onBar(bar(2 * m, 95), true);
    expect(buy!.price).toBeCloseTo(95 * 1.01);
    d.onBar(bar(3 * m, 96), true); d.onBar(bar(4 * m, 97), true);
    const [sell] = d.onBar(bar(5 * m, 98), true);
    expect(sell!.kind).toBe("dip-sell");
    expect(d.equity(98)).toBeCloseTo(100 * 98 / (95 * 1.01));
  });
  test("ignores dips when the coin is not in an uptrend", () => {
    const d = new DipSleeve(dipCfg, newDipState(100));
    d.onBar(bar(0, 100), false); d.onBar(bar(m, 94, 94, 90, 91), false);
    expect(d.onBar(bar(2 * m, 91), false)).toEqual([]);
  });
  test("forgets highs older than the window", () => {
    const d = new DipSleeve({ ...dipCfg, windowMin: 2 }, newDipState(100));
    d.onBar(bar(0, 100), true); d.onBar(bar(m, 95), true); d.onBar(bar(2 * m, 95), true);
    d.onBar(bar(3 * m, 95, 95, 93, 94), true); // 7% below the old 100 high, but only 2% below the 2-minute window
    expect(d.state.pending).toBe(false);
  });
});

describe("strategy enhancements", () => {
  test("accrues cash yield on idle cash during daily closes", () => {
    const s = new CoinStrategy({ ...cfg, mode: "hold", cashYieldApr: 0.05 }, newCoinState(10_000));
    s.onDailyClose(0, 100);
    expect(s.state.cash).toBeCloseTo(10_000 * (1 + 0.05 / 365.25));
  });
  test("uses maker fee when makerEntry is true", () => {
    const s = new CoinStrategy({ ...cfg, mode: "hold", makerBps: 20, takerBps: 50, makerEntry: true }, newCoinState(1000));
    s.state.regimeOn = true;
    const [fill] = s.onBar(bar(0, 100));
    expect(fill!.fee).toBeCloseTo(1000 * (20 / 1e4));
  });
});

