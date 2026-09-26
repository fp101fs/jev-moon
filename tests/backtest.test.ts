import { describe, expect, test } from "bun:test";
import { backtest, calibration, extractSteps, mulberry32, runStrategy, scoreCalls, STRATEGIES, type Step } from "../src/backtest";
import { PaperEngine } from "../src/paper";
import type { RecordingFrame } from "../src/recording";

const cfg = { startingCash: 10_000, maxPositionUsd: 2_000, feeBps: 0, slippageBps: 0, randomRuns: 50 };
const step = (timestamp: number, mid: number, jevAction: Step["jevAction"], jevConfidence = 0.9): Step =>
  ({ timestamp, symbol: "BTC/USD", bid: mid, ask: mid, mid, stale: false, return1s: 0, bookImbalance: 0, recentTradeFlow: 0, jevAction, jevConfidence, jevLean: 0 });

describe("backtest", () => {
  test("dedupes repeated decisions and skips markets without a book", () => {
    const market = (mid?: number) => ({ bid: mid, ask: mid, mid, decision: { timestamp: 1, action: "BUY", rawAction: "BUY", confidence: 0.9 } });
    const frame = (markets: any): RecordingFrame => ({ version: 1, offsetMs: 0, capturedAt: "", snapshot: { markets } });
    const steps = extractSteps([frame({ "BTC/USD": market(100), "ETH/USD": market() }), frame({ "BTC/USD": market(100) })]);
    expect(steps.map((s) => s.symbol)).toEqual(["BTC/USD"]);
  });
  test("a perfect caller scores 100% on direction", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => step(i * 1_000, 100 + (i % 2 ? -1 : 1) * i, i % 2 ? "BUY" : "SELL"));
    expect(scoreCalls(steps, STRATEGIES.jev!, 1_000).rate).toBe(1);
  });
  test("non-overlapping scoring skips calls made before the previous one resolves", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6].map((i) => step(i * 1_000, 100 + i, "BUY"));
    expect(scoreCalls(steps, STRATEGIES.jev!, 3_000).calls).toBe(2);
    expect(scoreCalls(steps, STRATEGIES.jev!, 3_000, false).calls).toBe(4);
  });
  test("reports the average move in bps in the called direction", () => {
    const steps = [step(0, 100, "SELL"), step(60_000, 99, "HOLD")];
    expect(scoreCalls(steps, STRATEGIES.jev!, 60_000).meanBps).toBeCloseTo(100);
  });
  test("lean scores HOLD decisions by which side Jev favoured", () => {
    const steps = [{ ...step(0, 100, "HOLD"), jevLean: 0.1 }, { ...step(10_000, 101, "HOLD"), jevLean: -0.2 }, step(20_000, 100, "HOLD")];
    const r = scoreCalls(steps, STRATEGIES["jev lean"]!, 10_000);
    expect([r.calls, r.hits]).toEqual([2, 2]);
  });
  test("calibration buckets calls by confidence, including those under the gate", () => {
    const steps = [step(0, 100, "BUY", 0.2), step(10_000, 101, "BUY", 0.8), step(20_000, 102, "HOLD")];
    expect(calibration(steps, 10_000).map((b) => b.calls)).toEqual([1, 0, 0, 1]);
  });
  test("calling a steady uptrend beats coin-flip direction", () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => step(i * 1_000, 100 + i, "BUY"));
    const { results, random } = backtest(steps, cfg);
    expect(results.jev!.pnl).toBeGreaterThan(random.p95);
  });
  test("counts fees on every fill, not just the engine's recent-fill window", () => {
    const steps = Array.from({ length: 300 }, (_, i) => step(i, 100, i % 2 ? "SELL" : "BUY"));
    expect(runStrategy(steps, STRATEGIES.jev!, { ...cfg, feeBps: 10 }).fees).toBeCloseTo(300 * 0.5);
  });
  test("low-confidence calls are held", () => {
    expect(runStrategy([step(0, 100, "BUY", 0.5)], STRATEGIES.jev!, cfg).trades).toBe(0);
  });
  test("random baseline is reproducible per seed", () => {
    const steps = [0, 1, 2, 3].map((i) => step(i * 1_000, 100 + i, "BUY"));
    expect(runStrategy(steps, STRATEGIES.random!, cfg, mulberry32(7)).pnl).toBe(runStrategy(steps, STRATEGIES.random!, cfg, mulberry32(7)).pnl);
  });
});

describe("equity with a missing price", () => {
  test("falls back to entry price instead of valuing the position at zero", () => {
    const p = new PaperEngine(10_000, 2_000, 0, 0);
    p.execute("ETH/USD", "BUY", 0.9, 100, 100);
    expect(p.equity({})).toBeCloseTo(10_000);
  });
});
