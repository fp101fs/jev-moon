import { momentumDecision } from "./jev";
import { gateAction, PaperEngine } from "./paper";
import { existsSync, readFileSync } from "node:fs";
import { metaPathFor, readRecording, type RecordingFrame } from "./recording";
import { SYMBOLS, type Action, type SymbolName } from "./types";

// Scores Jev's recorded decisions against simple baselines on identical prices, fees and sizing.
// Every strategy fills at the book seen *after* Jev answered, so Jev pays for its own latency.

export interface Step {
  timestamp: number;
  symbol: SymbolName;
  bid: number;
  ask: number;
  mid: number;
  stale: boolean;
  return1s: number;
  bookImbalance: number;
  recentTradeFlow: number;
  jevAction: Action;
  jevConfidence: number;
  /** P(BUY) − P(SELL): which way Jev leans, even when it says HOLD. */
  jevLean: number;
}

export interface BacktestConfig {
  startingCash: number;
  maxPositionUsd: number;
  feeBps: number;
  slippageBps: number;
  randomRuns: number;
}

type Strategy = (step: Step, rng: () => number) => { action: Action; confidence: number };

/** One step per (Jev decision, symbol), deduplicated by decision timestamp. */
export function extractSteps(frames: RecordingFrame[]): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const { snapshot } of frames) {
    for (const symbol of SYMBOLS) {
      const m = snapshot.markets?.[symbol];
      const d = m?.decision;
      if (!d || d.type === "error" || !(m.bid > 0 && m.ask >= m.bid)) continue;
      const key = `${symbol}@${d.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({
        timestamp: d.timestamp, symbol, bid: m.bid, ask: m.ask, mid: m.mid, stale: Boolean(m.stale),
        return1s: m.return1s ?? 0, bookImbalance: m.bookImbalance ?? 0, recentTradeFlow: m.recentTradeFlow ?? 0,
        jevAction: d.rawAction ?? d.action, jevConfidence: d.confidence,
        jevLean: (d.probabilities?.BUY ?? 0) - (d.probabilities?.SELL ?? 0),
      });
    }
  }
  return steps.sort((a, b) => a.timestamp - b.timestamp);
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jevAction = (s: Step): Action => gateAction(s.jevAction, s.jevConfidence, s.stale);

export const STRATEGIES: Record<string, Strategy> = {
  jev: (s) => ({ action: jevAction(s), confidence: s.jevConfidence }),
  momentum: (s) => { const d = momentumDecision(s); return { action: gateAction(d.action, d.confidence, s.stale), confidence: d.confidence }; },
  "buy & hold": () => ({ action: "BUY", confidence: 0.9 }),
  // Trades exactly when and as large as Jev does, but picks the direction by coin flip.
  // If Jev has no directional skill, its P&L should look like a typical draw from this.
  // Every BUY/SELL Jev said, including those under the 0.55 gate that never trade. Scored for direction only.
  "jev ungated": (s) => ({ action: s.jevAction, confidence: s.jevConfidence }),
  // Direction only: the side Jev puts more probability on, scored on every decision including HOLDs.
  "jev lean": (s) => ({ action: s.jevLean > 0 ? "BUY" : s.jevLean < 0 ? "SELL" : "HOLD", confidence: s.jevConfidence }),
  random: (s, rng) => ({ action: jevAction(s) === "HOLD" ? "HOLD" : rng() < 0.5 ? "BUY" : "SELL", confidence: s.jevConfidence }),
};

export function runStrategy(steps: Step[], strategy: Strategy, cfg: BacktestConfig, rng: () => number = Math.random) {
  const paper = new PaperEngine(cfg.startingCash, cfg.maxPositionUsd, cfg.feeBps, cfg.slippageBps);
  const lastMid: Partial<Record<SymbolName, number>> = {};
  let trades = 0, fees = 0; // counted here: PaperEngine.fills only keeps the latest 200
  for (const step of steps) {
    lastMid[step.symbol] = step.mid;
    const { action, confidence } = strategy(step, rng);
    const fill = paper.execute(step.symbol, action, confidence, step.bid, step.ask, step.timestamp);
    if (fill) { trades++; fees += fill.fee; }
  }
  return { pnl: paper.equity(lastMid) - cfg.startingCash, trades, fees };
}

export const COST_BPS = 12; // round trip: 5 bps fee each way + 1 bps slippage each way, as stated in the prompt

export interface CallScore { calls: number; hits: number; flat: number; rate: number; z: number; meanBps: number; beatCost: number }

/**
 * Scores BUY/SELL calls against the mid price horizonMs later. By default a call only counts if it starts after the
 * previous counted call on that symbol has resolved, so neighbouring calls can't share the same price move and
 * inflate z. meanBps is the average move in the called direction; it must exceed COST_BPS for a call to pay.
 */
export function scoreCalls(steps: Step[], strategy: Strategy, horizonMs: number, nonOverlapping = true): CallScore {
  const bySymbol = new Map<SymbolName, Step[]>();
  for (const s of steps) bySymbol.set(s.symbol, [...(bySymbol.get(s.symbol) ?? []), s]);
  let calls = 0, hits = 0, flat = 0, beat = 0, sumBps = 0;
  const maxLag = Math.max(2_000, horizonMs * 0.1); // skip calls whose outcome falls in a data gap
  for (const series of bySymbol.values()) {
    let j = 0, nextAllowed = -Infinity;
    for (let i = 0; i < series.length; i++) {
      const step = series[i]!;
      if (step.timestamp < nextAllowed) continue;
      const action = strategy(step, Math.random).action;
      if (action === "HOLD") continue;
      const target = step.timestamp + horizonMs;
      while (j < series.length && series[j]!.timestamp < target) j++;
      if (j >= series.length) break;
      if (series[j]!.timestamp - target > maxLag) continue;
      const bps = (series[j]!.mid / step.mid - 1) * 10_000 * (action === "BUY" ? 1 : -1);
      calls++;
      sumBps += bps;
      if (bps > COST_BPS) beat++;
      if (bps === 0) flat++;
      else if (bps > 0) hits++;
      if (nonOverlapping) nextAllowed = target;
    }
  }
  const decided = calls - flat;
  return {
    calls, hits, flat,
    rate: decided ? hits / decided : NaN,
    z: decided ? (hits - decided / 2) / Math.sqrt(decided / 4) : NaN,
    meanBps: calls ? sumBps / calls : NaN,
    beatCost: calls ? beat / calls : NaN,
  };
}

export const CONFIDENCE_BUCKETS: [number, number][] = [[0, 0.3], [0.3, 0.55], [0.55, 0.7], [0.7, 1.01]];

/** Is Jev right more often when it is more confident? Uses every raw BUY/SELL, bucketed by stated confidence. */
export function calibration(steps: Step[], horizonMs: number) {
  return CONFIDENCE_BUCKETS.map(([lo, hi]) => ({
    lo, hi,
    ...scoreCalls(steps, (s) => ({ action: s.jevConfidence >= lo && s.jevConfidence < hi ? s.jevAction : "HOLD", confidence: s.jevConfidence }), horizonMs),
  }));
}

export function backtest(steps: Step[], cfg: BacktestConfig) {
  const results = Object.fromEntries(Object.entries(STRATEGIES).filter(([name]) => !["random", "jev ungated", "jev lean"].includes(name))
    .map(([name, strategy]) => [name, runStrategy(steps, strategy, cfg)]));
  const draws = Array.from({ length: cfg.randomRuns }, (_, seed) => runStrategy(steps, STRATEGIES.random!, cfg, mulberry32(seed + 1)).pnl).sort((a, b) => a - b);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.floor(p * (draws.length - 1)))] ?? 0;
  const jevPnl = results.jev!.pnl;
  const random = {
    mean: draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length),
    p5: q(0.05), p50: q(0.5), p95: q(0.95),
    jevPercentile: draws.length ? draws.filter((x) => x < jevPnl).length / draws.length : NaN,
  };
  return { results, random };
}

if (import.meta.main) {
  const num = (name: string, fallback: number) => { const v = Number(Bun.env[name] ?? fallback); return Number.isFinite(v) ? v : fallback; };
  const list = (name: string, fallback: string) => (Bun.env[name] ?? fallback).split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const path = Bun.argv[2] ?? "recordings/example.jsonl";
  const horizons = list("HORIZONS_S", "5,30,60").map((s) => s * 1_000);
  const feeScenarios = list("FEE_SCENARIOS_BPS", "5,26");
  const base = { startingCash: num("STARTING_CASH", 10_000), maxPositionUsd: num("MAX_POSITION_USD", 2_000), slippageBps: num("PAPER_SLIPPAGE_BPS", 1), randomRuns: num("RANDOM_RUNS", 500) };
  const steps = extractSteps(readRecording(path));
  if (!steps.length) { console.error(`No decisions found in ${path}`); process.exit(1); }
  const meta = existsSync(metaPathFor(path)) ? JSON.parse(readFileSync(metaPathFor(path), "utf8")) : null;
  const minutes = (steps.at(-1)!.timestamp - steps[0]!.timestamp) / 60_000;
  const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
  const pct = (n: number) => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
  const fix = (n: number, d = 2) => Number.isFinite(n) ? n.toFixed(d) : "—";

  console.log(`\n${path}`);
  if (meta) console.log(`prompt ${meta.promptVersion} (${String(meta.promptHash).slice(0, 12)}) · ${meta.resolvedModels?.join(", ") || meta.requestedModel} · every ${meta.decisionIntervalMs}ms · started ${meta.startedAt}`);
  const counts = { BUY: 0, SELL: 0, HOLD: 0 } as Record<Action, number>;
  for (const s of steps) counts[s.jevAction]++;
  console.log(`${steps.length} symbol-decisions over ${minutes.toFixed(1)} min · Jev said BUY ${counts.BUY} · SELL ${counts.SELL} · HOLD ${counts.HOLD}`);

  console.log(`\n── Direction: move in the called direction, non-overlapping calls only (cost to beat: ${COST_BPS} bps round trip)`);
  console.log(`${"strategy".padEnd(13)}${"horizon".padStart(8)}${"calls".padStart(7)}${"hit rate".padStart(10)}${"z".padStart(7)}${"avg move".padStart(11)}${"> cost".padStart(8)}`);
  for (const name of ["jev lean", "jev ungated", "jev", "momentum"]) {
    for (const h of horizons) {
      const r = scoreCalls(steps, STRATEGIES[name]!, h);
      console.log(`${name.padEnd(13)}${`${h / 1000}s`.padStart(8)}${String(r.calls).padStart(7)}${pct(r.rate).padStart(10)}${fix(r.z).padStart(7)}${`${fix(r.meanBps, 1)}bps`.padStart(11)}${pct(r.beatCost).padStart(8)}`);
    }
  }

  const calH = horizons.includes(60_000) ? 60_000 : horizons.at(-1)!;
  console.log(`\n── Confidence calibration: Jev's raw BUY/SELL calls at ${calH / 1000}s, bucketed by stated confidence`);
  console.log(`${"confidence".padEnd(13)}${"calls".padStart(7)}${"hit rate".padStart(10)}${"avg move".padStart(11)}${"> cost".padStart(8)}`);
  for (const b of calibration(steps, calH)) {
    console.log(`${`${b.lo.toFixed(2)}–${Math.min(1, b.hi).toFixed(2)}`.padEnd(13)}${String(b.calls).padStart(7)}${pct(b.rate).padStart(10)}${`${fix(b.meanBps, 1)}bps`.padStart(11)}${pct(b.beatCost).padStart(8)}`);
  }

  for (const feeBps of feeScenarios) {
    const { results, random } = backtest(steps, { ...base, feeBps });
    console.log(`\n── Paper P&L at ${feeBps} bps fee + ${base.slippageBps} bps slippage per side${feeBps >= 20 ? " (realistic Kraken retail taker)" : ""}`);
    console.log(`${"strategy".padEnd(13)}${"P&L".padStart(11)}${"trades".padStart(8)}${"fees".padStart(10)}`);
    for (const [name, r] of Object.entries(results)) console.log(`${name.padEnd(13)}${money(r.pnl).padStart(11)}${String(r.trades).padStart(8)}${money(-r.fees).padStart(10)}`);
    console.log(`random       median ${money(random.p50)} · 90% range ${money(random.p5)} … ${money(random.p95)} · Jev beat ${pct(random.jevPercentile)} of ${base.randomRuns} runs`);
  }

  const verdictH = calH;
  // Prefer Jev's actual BUY/SELL calls; if it almost never makes any, judge its lean instead.
  const ungated = scoreCalls(steps, STRATEGIES["jev ungated"]!, verdictH);
  const useLean = ungated.calls - ungated.flat < 100;
  const v = useLean ? scoreCalls(steps, STRATEGIES["jev lean"]!, verdictH) : ungated;
  const n = v.calls - v.flat;
  console.log(`\n── Verdict (${verdictH / 1000}s, ${useLean ? `Jev's lean — it made only ${ungated.calls} scorable BUY/SELL calls` : "Jev's raw BUY/SELL calls"})`);
  console.log(n < 100
    ? `Too few non-overlapping calls (${n}) to judge. Aim for 100+ at this horizon.`
    : `${Math.abs(v.z) >= 2 ? `Hit rate ${pct(v.rate)} is ${v.z > 0 ? "above" : "below"} chance (z ${fix(v.z)}).` : `Hit rate ${pct(v.rate)} is not distinguishable from a coin flip (z ${fix(v.z)}).`} ` +
      `Average move in the called direction: ${fix(v.meanBps, 1)} bps vs ${COST_BPS} bps cost — ${v.meanBps > COST_BPS ? "enough to pay for trading." : "not enough to pay for trading."}`);
}
