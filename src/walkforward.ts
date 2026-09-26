import { mkdirSync, writeFileSync } from "node:fs";
import { mulberry32 } from "./backtest";
import { breakout, ema, indexAt, loadBars, meanReversion, randomPositions, resample, runPositions, trend, type Bars, type Signal } from "./candles";

// Rolling walk-forward: tune on 12 months, trade the next 3 months with the chosen settings, step forward 3 months.
// Every reported number comes from months the tuning never saw. Positions are closed at each window boundary
// (one extra round trip per quarter), which slightly understates every strategy equally.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const TIMEFRAMES = (Bun.env.TIMEFRAMES ?? "15,60,240").split(",").map(Number);
const FIRST_TEST = Date.UTC(2022, 0, 1), END = Date.UTC(2026, 8, 1);
const TRAIN_MONTHS = 12, TEST_MONTHS = 3;
const SLIPPAGE_BPS = 2;
const RANDOM_RUNS = Number(Bun.env.RANDOM_RUNS ?? 20);
const FEES = [
  { name: "kraken-new", takerBps: 80 },
  { name: "kraken-10k", takerBps: 38 },
  { name: "low-fee", takerBps: 10 },
];

/** Only allow longs while price is above its 200-day EMA. */
const withRegime = (signal: Signal, barsPerDay: number): Signal => (b) => {
  const pos = signal(b), slow = ema(b.c, 200 * barsPerDay);
  for (let i = 0; i < pos.length; i++) if (b.c[i]! <= slow[i]!) pos[i] = 0;
  return pos;
};

interface Candidate { family: string; label: string; make: (barsPerDay: number) => Signal }
const base: Candidate[] = [
  ...[[10, 30], [20, 50], [50, 200], [100, 400]].map(([f, s]) => ({ family: "trend", label: `EMA ${f}/${s}`, make: () => trend(f!, s!) })),
  ...[20, 55, 100, 200, 400].map((n) => ({ family: "breakout", label: `${n}-bar high`, make: () => breakout(n) })),
  ...[[20, 2], [50, 2], [50, 2.5], [100, 2.5], [100, 3]].map(([n, k]) => ({ family: "mean reversion", label: `${n} bars ${k}σ`, make: () => meanReversion(n!, k!) })),
];
const CANDIDATES: Candidate[] = base.flatMap((c) => [c, { ...c, label: `${c.label} +regime`, make: (bpd: number) => withRegime(c.make(bpd), bpd) }]);
const FAMILIES = [...new Set(CANDIDATES.map((c) => c.family)), "system"]; // "system" picks the best family each window

const addMonths = (ms: number, n: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1); };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const windows: { trainFrom: number; testFrom: number; testTo: number }[] = [];
for (let t = FIRST_TEST; t < END; t = addMonths(t, TEST_MONTHS)) windows.push({ trainFrom: addMonths(t, -TRAIN_MONTHS), testFrom: t, testTo: Math.min(addMonths(t, TEST_MONTHS), END) });

const started = Date.now();
const raw = Object.fromEntries(SYMBOLS.map((s) => [s, loadBars(`data/klines/${s}USDT-1m-hist.csv`)]));
const report: any[] = [];

for (const tf of TIMEFRAMES) {
  const barsPerDay = 1440 / tf;
  const bars: Record<string, Bars> = Object.fromEntries(SYMBOLS.map((s) => [s, resample(raw[s]!, tf)]));
  const positions = CANDIDATES.map((c) => Object.fromEntries(SYMBOLS.map((s) => [s, c.make(barsPerDay)(bars[s]!)])));
  const idx = (s: string, ms: number) => indexAt(bars[s]!, ms);

  for (const fee of FEES) {
    const cost = fee.takerBps + SLIPPAGE_BPS;
    const run = (k: number, from: number, to: number) => SYMBOLS.map((s) => runPositions(bars[s]!, positions[k]![s]!, cost, idx(s, from), idx(s, to)));
    const equity: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 1]));
    const randomEquity: Record<string, number[]> = Object.fromEntries(FAMILIES.map((f) => [f, Array(RANDOM_RUNS).fill(1)]));
    const worst: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
    const trades: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
    const exposure: Record<string, number[]> = Object.fromEntries(FAMILIES.map((f) => [f, []]));
    const picks: Record<string, string[]> = Object.fromEntries(FAMILIES.map((f) => [f, []]));
    let buyHold = 1;

    windows.forEach((w, wi) => {
      const trainRet = CANDIDATES.map((_, k) => mean(run(k, w.trainFrom, w.testFrom).map((r) => r.ret)));
      const bestOf = (family: string) => CANDIDATES.map((c, k) => ({ c, k })).filter(({ c }) => family === "system" || c.family === family).sort((a, b) => trainRet[b.k]! - trainRet[a.k]!)[0]!;
      for (const family of FAMILIES) {
        const { c, k } = bestOf(family);
        const test = run(k, w.testFrom, w.testTo);
        const ret = mean(test.map((r) => r.ret));
        equity[family]! *= 1 + ret;
        worst[family] = Math.min(worst[family]!, ret);
        trades[family]! += test.reduce((a, r) => a + r.trades, 0);
        exposure[family]!.push(mean(test.map((r) => r.exposure)));
        picks[family]!.push(`${c.family === family ? "" : `${c.family}: `}${c.label}`);
        for (let r = 0; r < RANDOM_RUNS; r++) {
          const rr = mean(SYMBOLS.map((s, si) => {
            const b = bars[s]!, from = idx(s, w.testFrom), to = idx(s, w.testTo);
            return runPositions(b, randomPositions(b.c.length, from, to, test[si]!.holds, mulberry32(wi * 1000 + r * 10 + si + 1)), cost, from, to).ret;
          }));
          randomEquity[family]![r]! *= 1 + rr;
        }
      }
      buyHold *= 1 + mean(SYMBOLS.map((s) => { const b = bars[s]!, from = idx(s, w.testFrom), to = idx(s, w.testTo); return (b.c[to - 1]! / b.o[from]!) * (1 - cost / 1e4) ** 2 - 1; }));
    });

    const years = (END - FIRST_TEST) / (365.25 * 86_400_000), days = years * 365.25;
    for (const family of FAMILIES) {
      const r = randomEquity[family]!.sort((a, b) => a - b);
      report.push({
        timeframe: tf, fee: fee.name, family,
        totalReturn: equity[family]! - 1, cagr: equity[family]! ** (1 / years) - 1,
        buyHold: buyHold - 1, buyHoldCagr: buyHold ** (1 / years) - 1,
        beatsRandom: r.filter((x) => x < equity[family]!).length / r.length, randomMedian: r[Math.floor(r.length / 2)]! - 1,
        worstQuarter: worst[family], tradesPerDay: trades[family]! / days, exposure: mean(exposure[family]!),
        picks: picks[family],
      });
    }
  }
  console.error(`${tf}m done · ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

const pct = (n: number) => Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%` : "—";
console.log(`\nWalk-forward out-of-sample: ${windows.length} quarters, Jan 2022 – Aug 2026 · tune on prior ${TRAIN_MONTHS} months · BTC/ETH/SOL equal thirds · long-only`);
for (const fee of FEES) {
  const bh = report.find((r) => r.fee === fee.name)!;
  console.log(`\n── ${fee.name} (${fee.takerBps} bps + ${SLIPPAGE_BPS} slippage per side) · buy & hold: total ${pct(bh.buyHold)}, ${pct(bh.buyHoldCagr)}/yr`);
  console.log(`${"tf".padEnd(6)}${"strategy".padEnd(16)}${"total".padStart(8)}${"per yr".padStart(8)}${"> random".padStart(10)}${"random med".padStart(12)}${"worst qtr".padStart(11)}${"trades/day".padStart(12)}${"in mkt".padStart(8)}`);
  for (const r of report.filter((r) => r.fee === fee.name)) {
    console.log(`${`${r.timeframe}m`.padEnd(6)}${r.family.padEnd(16)}${pct(r.totalReturn).padStart(8)}${pct(r.cagr).padStart(8)}${`${Math.round(r.beatsRandom * 100)}%`.padStart(10)}${pct(r.randomMedian).padStart(12)}${pct(r.worstQuarter).padStart(11)}${r.tradesPerDay.toFixed(2).padStart(12)}${`${Math.round(r.exposure * 100)}%`.padStart(8)}`);
  }
}
mkdirSync("data/results", { recursive: true });
writeFileSync("data/results/walkforward.json", JSON.stringify({ windows, fees: FEES, report }, null, 2));
console.log(`\nSaved data/results/walkforward.json · ${((Date.now() - started) / 1000).toFixed(0)}s`);
