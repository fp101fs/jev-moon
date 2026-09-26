import { mkdirSync, writeFileSync } from "node:fs";
import { mulberry32 } from "./backtest";
import { breakout, indexAt, loadBars, meanReversion, randomPositions, resample, runGrid, runPositions, trend, type Bars, type RunResult, type Signal } from "./candles";

// Tune each strategy on the first 8 months, then score the chosen settings on the last 4 months it never saw.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const TIMEFRAMES = [1, 5, 15, 60];
const TRAIN_START = Date.UTC(2025, 8, 1), SPLIT = Date.UTC(2026, 4, 1), TEST_END = Date.UTC(2026, 8, 1);
const SLIPPAGE_BPS = 2;
const RANDOM_RUNS = Number(Bun.env.RANDOM_RUNS ?? 30);
// Per side. Kraken Pro published schedule (Sep 2026): new account 0.40% maker / 0.80% taker; $10k+ 30-day volume 0.22% / 0.38%.
const FEES = [
  { name: "kraken-new", takerBps: 80, makerBps: 40 },
  { name: "kraken-10k", takerBps: 38, makerBps: 22 },
  { name: "low-fee", takerBps: 10, makerBps: 10 },
];

const FAMILIES: Record<string, { label: (p: number[]) => string; grid: number[][]; make: (p: number[]) => Signal }> = {
  trend: { label: ([f, s]) => `EMA ${f}/${s}`, grid: [[5, 20], [10, 30], [20, 50], [50, 200]], make: ([f, s]) => trend(f!, s!) },
  "mean reversion": { label: ([n, k]) => `${n} bars, ${k}σ`, grid: [20, 50, 100].flatMap((n) => [1.5, 2, 2.5, 3].map((k) => [n, k])), make: ([n, k]) => meanReversion(n!, k!) },
  breakout: { label: ([n]) => `${n}-bar high`, grid: [[20], [55], [100], [200]], make: ([n]) => breakout(n!) },
};
const GRID_PARAMS = [0.005, 0.01, 0.02, 0.04].flatMap((s) => [5, 10].map((u) => [s, u]));

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] ?? NaN; };

interface Row {
  timeframe: number; strategy: string; params: string; fee: string;
  trainRet: number; testRet: number; buyHold: number; beatsRandom: number | null; randomMedian: number | null;
  tradesPerDay: number; winRate: number; exposure: number; maxDrawdown: number; fees: number;
}

function summarize(results: RunResult[], days: number) {
  const trades = results.reduce((a, r) => a + r.trades, 0);
  return {
    ret: mean(results.map((r) => r.ret)), // equal thirds per coin, no rebalancing
    tradesPerDay: trades / days,
    winRate: trades ? results.reduce((a, r) => a + r.wins, 0) / trades : NaN,
    exposure: mean(results.map((r) => r.exposure)),
    maxDrawdown: mean(results.map((r) => r.maxDrawdown)),
    fees: mean(results.map((r) => r.fees)),
  };
}

const started = Date.now();
const raw = Object.fromEntries(SYMBOLS.map((s) => [s, loadBars(`data/klines/${s}USDT-1m.csv`)]));
const testDays = (TEST_END - SPLIT) / 86_400_000;
const rows: Row[] = [];
const moves: Record<number, number> = {};

for (const tf of TIMEFRAMES) {
  const bars: Record<string, Bars> = Object.fromEntries(SYMBOLS.map((s) => [s, resample(raw[s]!, tf)]));
  const span = (b: Bars) => ({ trainFrom: indexAt(b, TRAIN_START), split: indexAt(b, SPLIT), testTo: indexAt(b, TEST_END) });
  moves[tf] = mean(SYMBOLS.map((s) => { const b = bars[s]!; return median(Array.from(b.c, (c, i) => Math.abs(c / b.o[i]! - 1) * 10_000)); }));
  const buyHold = (costBps: number) => mean(SYMBOLS.map((s) => { const b = bars[s]!, { split, testTo } = span(b); return (b.c[testTo - 1]! / b.o[split]!) * (1 - costBps / 1e4) ** 2 - 1; }));

  for (const [family, spec] of Object.entries(FAMILIES)) {
    const positions = spec.grid.map((p) => Object.fromEntries(SYMBOLS.map((s) => [s, spec.make(p)(bars[s]!)])));
    for (const fee of FEES) {
      const cost = fee.takerBps + SLIPPAGE_BPS;
      const trainRets = spec.grid.map((_, k) => mean(SYMBOLS.map((s) => { const b = bars[s]!, { trainFrom, split } = span(b); return runPositions(b, positions[k]![s]!, cost, trainFrom, split).ret; })));
      const best = trainRets.indexOf(Math.max(...trainRets));
      const test = SYMBOLS.map((s) => { const b = bars[s]!, { split, testTo } = span(b); return runPositions(b, positions[best]![s]!, cost, split, testTo); });
      const draws = Array.from({ length: RANDOM_RUNS }, (_, run) => mean(SYMBOLS.map((s, si) => {
        const b = bars[s]!, { split, testTo } = span(b);
        return runPositions(b, randomPositions(b.c.length, split, testTo, test[si]!.holds, mulberry32(run * 7 + si + 1)), cost, split, testTo).ret;
      })));
      const sum = summarize(test, testDays);
      rows.push({
        timeframe: tf, strategy: family, params: spec.label(spec.grid[best]!), fee: fee.name,
        trainRet: trainRets[best]!, testRet: sum.ret, buyHold: buyHold(cost),
        beatsRandom: draws.filter((d) => d < sum.ret).length / draws.length, randomMedian: median(draws),
        tradesPerDay: sum.tradesPerDay, winRate: sum.winRate, exposure: sum.exposure, maxDrawdown: sum.maxDrawdown, fees: sum.fees,
      });
    }
  }

  if (tf === 1) {
    for (const fee of FEES) {
      const trainRets = GRID_PARAMS.map(([sp, u]) => mean(SYMBOLS.map((s) => { const b = bars[s]!, { trainFrom, split } = span(b); return runGrid(b, sp!, u!, fee.makerBps, trainFrom, split).ret; })));
      const best = trainRets.indexOf(Math.max(...trainRets));
      const [sp, u] = GRID_PARAMS[best]!;
      const test = SYMBOLS.map((s) => { const b = bars[s]!, { split, testTo } = span(b); return runGrid(b, sp!, u!, fee.makerBps, split, testTo); });
      const sum = summarize(test, testDays);
      rows.push({
        timeframe: 1, strategy: "grid", params: `${(sp! * 100).toFixed(1)}% steps, ${u} slots`, fee: fee.name,
        trainRet: trainRets[best]!, testRet: sum.ret, buyHold: buyHold(fee.takerBps + SLIPPAGE_BPS), beatsRandom: null, randomMedian: null,
        tradesPerDay: sum.tradesPerDay, winRate: sum.winRate, exposure: sum.exposure, maxDrawdown: sum.maxDrawdown, fees: sum.fees,
      });
    }
  }
}

const pct = (n: number | null, d = 1) => n === null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const plain = (n: number | null) => n === null || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`;

console.log(`\nTrain: Sep 2025 – Apr 2026 · Test: May – Aug 2026 (${testDays} days) · BTC, ETH, SOL equal thirds · long-only · slippage ${SLIPPAGE_BPS} bps/side`);
console.log(`\nTypical bar move (median |close/open − 1|): ${TIMEFRAMES.map((tf) => `${tf}m ${moves[tf]!.toFixed(1)} bps`).join(" · ")}`);
console.log(`Round-trip cost: ${FEES.map((f) => `${f.name} ${2 * (f.takerBps + SLIPPAGE_BPS)} bps taker / ${2 * f.makerBps} bps maker`).join(" · ")}`);
for (const fee of FEES) {
  console.log(`\n── ${fee.name} fees (test period)`);
  console.log(`${"tf".padEnd(5)}${"strategy".padEnd(16)}${"chosen settings".padEnd(22)}${"test".padStart(9)}${"buy&hold".padStart(10)}${"> random".padStart(10)}${"trades/day".padStart(12)}${"win".padStart(6)}${"in mkt".padStart(8)}${"max DD".padStart(8)}${"fees".padStart(8)}${"train".padStart(9)}`);
  for (const r of rows.filter((r) => r.fee === fee.name)) {
    console.log(`${`${r.timeframe}m`.padEnd(5)}${r.strategy.padEnd(16)}${r.params.padEnd(22)}${pct(r.testRet).padStart(9)}${pct(r.buyHold).padStart(10)}${plain(r.beatsRandom).padStart(10)}${r.tradesPerDay.toFixed(1).padStart(12)}${plain(r.winRate).padStart(6)}${plain(r.exposure).padStart(8)}${pct(-r.maxDrawdown, 0).padStart(8)}${pct(-r.fees, 0).padStart(8)}${pct(r.trainRet).padStart(9)}`);
  }
}

mkdirSync("data/results", { recursive: true });
const out = `data/results/candles-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify({ trainStart: TRAIN_START, split: SPLIT, testEnd: TEST_END, slippageBps: SLIPPAGE_BPS, fees: FEES, randomRuns: RANDOM_RUNS, moves, rows }, null, 2));
console.log(`\nSaved ${out} · ${((Date.now() - started) / 1000).toFixed(0)}s`);
