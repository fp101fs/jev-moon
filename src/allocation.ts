import { mkdirSync, writeFileSync } from "node:fs";
import { ema, indexAt, loadBars, resample, type Bars } from "./candles";

// Allocation rules instead of entry/exit timing: hold some fraction of the portfolio in BTC/ETH/SOL and
// rebalance to it. Every configuration is reported (no picking the best), over the same Jan 2022 – Aug 2026 span.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const START = Date.UTC(2022, 0, 1), END = Date.UTC(2026, 8, 1);
const TF = 60, BARS_PER_DAY = 24;
const SLIPPAGE_BPS = 2;
const FEES = [{ name: "kraken-new", takerBps: 80 }, { name: "kraken-10k", takerBps: 38 }, { name: "low-fee", takerBps: 10 }];

interface Config {
  name: string;
  rebalanceBars: number;   // 0 = never (buy & hold)
  band: number;            // skip trades smaller than this share of portfolio value
  weight: (s: number, i: number) => number; // target share of portfolio for coin s at bar i
}

const bars: Bars[] = SYMBOLS.map((s) => resample(loadBars(`data/klines/${s}USDT-1m-hist.csv`), TF));
const from = bars.map((b) => indexAt(b, START)), to = bars.map((b) => indexAt(b, END));
const n = Math.min(...bars.map((b, s) => to[s]! - from[s]!));
const price = (s: number, i: number) => bars[s]!.c[from[s]! + i]!;
for (let i = 0; i < n; i += 1000) if (new Set(bars.map((b, s) => b.t[from[s]! + i])).size !== 1) throw new Error(`bars misaligned at ${i}`);

// Annualized volatility of hourly returns over the prior 30 days, and a 200-day EMA regime flag, per coin.
const vol = bars.map((b, s) => {
  const out = new Float64Array(n), w = 30 * BARS_PER_DAY;
  const r = (i: number) => Math.log(b.c[from[s]! + i]! / b.c[from[s]! + i - 1]!);
  let sum = 0, sq = 0;
  for (let i = 1; i < n; i++) {
    const x = r(i); sum += x; sq += x * x;
    if (i > w) { const y = r(i - w); sum -= y; sq -= y * y; }
    const k = Math.min(i, w), m = sum / k;
    out[i] = Math.sqrt(Math.max(0, sq / k - m * m) * BARS_PER_DAY * 365);
  }
  return out;
});
/** In once price clears the EMA by `band`, out once it falls `band` below it. */
function regimeFlags(days: number, band: number): Uint8Array[] {
  return bars.map((b, s) => {
    const e = ema(b.c, days * BARS_PER_DAY), out = new Uint8Array(n);
    let on = 0;
    for (let i = 0; i < n; i++) {
      const p = b.c[from[s]! + i]!, m = e[from[s]! + i]!;
      if (!on && p > m * (1 + band)) on = 1; else if (on && p < m * (1 - band)) on = 0;
      out[i] = on;
    }
    return out;
  });
}
const regime = bars.map((b, s) => { const e = ema(b.c, 200 * BARS_PER_DAY); return Uint8Array.from({ length: n }, (_, i) => (b.c[from[s]! + i]! > e[from[s]! + i]! ? 1 : 0)); });

const configs: Config[] = [
  { name: "buy & hold (no rebalance)", rebalanceBars: 0, band: 0, weight: () => 1 / 3 },
  ...[1, 0.5, 0.33].flatMap((f) => [BARS_PER_DAY, 7 * BARS_PER_DAY].map((rb) => ({
    name: `${Math.round(f * 100)}% invested, rebalance ${rb === BARS_PER_DAY ? "daily" : "weekly"}`, rebalanceBars: rb, band: 0.01, weight: () => f / 3,
  }))),
  ...[0.4, 0.6, 0.8].map((target) => ({
    name: `vol target ${target * 100}%, daily`, rebalanceBars: BARS_PER_DAY, band: 0.02,
    weight: (s: number, i: number) => Math.min(1, target / Math.max(1e-9, vol[s]![i]!)) / 3,
  })),
  ...[0.4, 0.6, 0.8].map((target) => ({
    name: `vol target ${target * 100}% + regime, daily`, rebalanceBars: BARS_PER_DAY, band: 0.02,
    weight: (s: number, i: number) => regime[s]![i]! ? Math.min(1, target / Math.max(1e-9, vol[s]![i]!)) / 3 : 0,
  })),
  { name: "regime only (in/out), daily", rebalanceBars: BARS_PER_DAY, band: 0.02, weight: (s: number, i: number) => (regime[s]![i]! ? 1 / 3 : 0) },
];

function simulate(cfg: Config, costBps: number, yearly?: Record<string, number>) {
  const cost = costBps / 10_000;
  let cash = 1, peak = 1, maxDrawdown = 0, traded = 0, fees = 0, trades = 0;
  const units = SYMBOLS.map(() => 0);
  const daily: number[] = [];
  const value = (i: number) => cash + units.reduce((a, u, s) => a + u * price(s, i), 0);
  for (let i = 0; i < n; i++) {
    const rebalance = i === 0 || (cfg.rebalanceBars > 0 && i % cfg.rebalanceBars === 0);
    if (rebalance) {
      const v = value(i);
      SYMBOLS.forEach((_, s) => {
        const p = price(s, i), diff = cfg.weight(s, i) * v - units[s]! * p;
        if (Math.abs(diff) < cfg.band * v && i > 0) return;
        const fee = Math.abs(diff) * cost;
        units[s]! += diff / p; cash -= diff + fee; fees += fee; traded += Math.abs(diff); if (Math.abs(diff) > 1e-9) trades++;
      });
    }
    const v = value(i);
    peak = Math.max(peak, v); maxDrawdown = Math.max(maxDrawdown, 1 - v / peak);
    if (i % BARS_PER_DAY === 0) daily.push(v);
    if (yearly) { const y = new Date(bars[0]!.t[from[0]! + i]!).getUTCFullYear(); yearly[y] ??= v; yearly[`${y}-end`] = v; }
  }
  const final = value(n - 1), years = n / BARS_PER_DAY / 365.25;
  const rets = daily.slice(1).map((v, k) => v / daily[k]! - 1);
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mu) ** 2, 0) / rets.length);
  return { total: final - 1, cagr: final ** (1 / years) - 1, maxDrawdown, sharpe: (mu / sd) * Math.sqrt(365), tradesPerDay: trades / (years * 365.25), fees };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
const report: any[] = [];
console.log(`\nAllocation rules · Jan 2022 – Aug 2026 · BTC/ETH/SOL equal thirds · ${SLIPPAGE_BPS} bps slippage · every configuration shown`);
for (const fee of FEES) {
  console.log(`\n── ${fee.name} (${fee.takerBps} bps per side)`);
  console.log(`${"rule".padEnd(38)}${"total".padStart(8)}${"per yr".padStart(8)}${"max DD".padStart(8)}${"Sharpe".padStart(8)}${"trades/day".padStart(12)}${"fees".padStart(7)}`);
  for (const cfg of configs) {
    const r = simulate(cfg, fee.takerBps + SLIPPAGE_BPS);
    report.push({ fee: fee.name, rule: cfg.name, ...r });
    console.log(`${cfg.name.padEnd(38)}${pct(r.total).padStart(8)}${pct(r.cagr).padStart(8)}${pct(-r.maxDrawdown).padStart(8)}${r.sharpe.toFixed(2).padStart(8)}${r.tradesPerDay.toFixed(2).padStart(12)}${pct(-r.fees).padStart(7)}`);
  }
}
mkdirSync("data/results", { recursive: true });
writeFileSync("data/results/allocation.json", JSON.stringify(report, null, 2));

// ── Robustness: is the regime result a fluke of the 200-day choice, one coin, or one year? ──────────
const ROBUST_FEE = FEES[1]!;
const robustCost = ROBUST_FEE.takerBps + SLIPPAGE_BPS;
console.log(`\n── Robustness at ${ROBUST_FEE.name} fees: regime EMA length × buffer (total return / max DD / fees)`);
const bands = [0, 0.02, 0.05];
console.log(`${"EMA days".padEnd(10)}${bands.map((b) => `buffer ${b * 100}%`.padStart(26)).join("")}`);
const robust: any[] = [];
for (const days of [100, 150, 200, 250, 300]) {
  const cells = bands.map((band) => {
    const flags = regimeFlags(days, band);
    const r = simulate({ name: "", rebalanceBars: BARS_PER_DAY, band: 0.02, weight: (s, i) => (flags[s]![i]! ? 1 / 3 : 0) }, robustCost);
    robust.push({ days, band, ...r });
    return `${pct(r.total)} / ${pct(-r.maxDrawdown)} / ${pct(-r.fees)}`.padStart(26);
  });
  console.log(`${String(days).padEnd(10)}${cells.join("")}`);
}

console.log(`\n── Per coin (regime 200d, 2% buffer) vs that coin's buy & hold, ${ROBUST_FEE.name} fees`);
const flags = regimeFlags(200, 0.02);
SYMBOLS.forEach((sym, only) => {
  const r = simulate({ name: "", rebalanceBars: BARS_PER_DAY, band: 0.02, weight: (s, i) => (s === only && flags[s]![i]! ? 1 : 0) }, robustCost);
  const bh = simulate({ name: "", rebalanceBars: 0, band: 0, weight: (s) => (s === only ? 1 : 0) }, robustCost);
  console.log(`${sym.padEnd(5)} regime ${pct(r.total).padStart(6)} (DD ${pct(-r.maxDrawdown)}) · buy & hold ${pct(bh.total).padStart(6)} (DD ${pct(-bh.maxDrawdown)})`);
});

console.log(`\n── By calendar year, ${ROBUST_FEE.name} fees`);
const yr = (cfg: Config) => { const y: Record<string, number> = {}; simulate(cfg, robustCost, y); return y; };
const rows = {
  "buy & hold": yr(configs[0]!),
  "regime 200d, 2% buffer": yr({ name: "", rebalanceBars: BARS_PER_DAY, band: 0.02, weight: (s, i) => (flags[s]![i]! ? 1 / 3 : 0) }),
  "vol 40% + regime 200d, 2% buffer": yr({ name: "", rebalanceBars: BARS_PER_DAY, band: 0.02, weight: (s, i) => (flags[s]![i]! ? Math.min(1, 0.4 / Math.max(1e-9, vol[s]![i]!)) / 3 : 0) }),
};
const years = [2022, 2023, 2024, 2025, 2026];
console.log(`${"".padEnd(34)}${years.map((y) => String(y === 2026 ? "2026 (to Aug)" : y).padStart(14)).join("")}`);
for (const [name, y] of Object.entries(rows)) console.log(`${name.padEnd(34)}${years.map((yy) => pct(y[`${yy}-end`]! / y[yy]! - 1).padStart(14)).join("")}`);
writeFileSync("data/results/allocation-robustness.json", JSON.stringify({ robust, yearly: rows }, null, 2));
