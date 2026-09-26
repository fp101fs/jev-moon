import { mkdirSync, writeFileSync } from "node:fs";
import { indexAt, loadBars, resample, type Bars } from "./candles";
import { CoinStrategy, DEFAULT_CONFIG, newCoinState, type StrategyConfig } from "./strategy";

// What does each candidate feel like day to day? Simulated on 1-minute bars (so grid fills see intrabar highs/lows),
// Jan 2022 – Aug 2026, BTC/ETH/SOL equal thirds, no rebalancing between coins. Every configuration is reported.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const START = Date.UTC(2022, 0, 1), END = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;
const FEES = [{ name: "kraken-10k", takerBps: 38 + 2, makerBps: 22 }, { name: "low-fee", takerBps: 10 + 2, makerBps: 8 }];

type Strategy = { name: string; run: (b: Bars, from: number, to: number, daily: Bars, fee: (typeof FEES)[number]) => Map<number, number> };

/** Records equity at the first bar of each UTC day. */
const recorder = (b: Bars) => { const days = new Map<number, number>(); return { days, mark: (i: number, eq: number) => { const d = Math.floor(b.t[i]! / DAY); if (!days.has(d)) days.set(d, eq); } }; };

const buyHold: Strategy = { name: "buy & hold", run: (b, from, to, _r, fee) => {
  const rec = recorder(b), qty = (1 - fee.takerBps / 1e4) / b.o[from]!;
  for (let i = from; i < to; i++) rec.mark(i, qty * b.c[i]!);
  return rec.days;
} };

/** Runs the shared bot strategy (src/strategy.ts) over the window, feeding each completed day's close before the next day. */
const shared = (name: string, cfg: Partial<StrategyConfig>, alwaysOn = false): Strategy => ({ name, run: (b, from, to, daily, fee) => {
  const rec = recorder(b);
  const coin = new CoinStrategy({ ...DEFAULT_CONFIG, ...cfg, makerBps: fee.makerBps, takerBps: fee.takerBps }, newCoinState(1));
  let k = 0;
  const feed = (upTo: number) => { while (k < daily.c.length && daily.t[k]! + DAY <= upTo) { coin.onDailyClose(daily.t[k]!, daily.c[k]!); k++; } };
  feed(b.t[from]!);
  if (alwaysOn) coin.state.regimeOn = true;
  for (let i = from; i < to; i++) {
    if (!alwaysOn) feed(b.t[i]!);
    coin.onBar({ t: b.t[i]!, o: b.o[i]!, h: b.h[i]!, l: b.l[i]!, c: b.c[i]! });
    rec.mark(i, coin.equity(b.c[i]!));
  }
  return rec.days;
} });

const STRATEGIES: Strategy[] = [
  buyHold,
  shared("regime (200d, 5% buffer)", { mode: "hold", trailingStop: 0 }),
  shared("regime + 10% trailing stop", { mode: "hold", trailingStop: 0.1 }),
  ...[0.01, 0.02, 0.04].flatMap((spacing) => [
    shared(`grid always ${spacing * 100}% × 10`, { mode: "grid", spacing, trailingStop: 0 }, true),
    shared(`grid + regime ${spacing * 100}% × 10`, { mode: "grid", spacing, trailingStop: 0 }),
  ]),
];

const bars = SYMBOLS.map((s) => loadBars(`data/klines/${s}USDT-1m-hist.csv`));
const spans = bars.map((b) => ({ from: indexAt(b, START), to: indexAt(b, END) }));
const dailyBars = bars.map((b) => resample(b, 1440));

const pct = (x: number, d = 0) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
const report: any[] = [];
console.log(`\nDaily experience · Jan 2022 – Aug 2026 · BTC/ETH/SOL equal thirds · per $10,000 starting capital`);
for (const fee of FEES) {
  console.log(`\n── ${fee.name} (taker ${fee.takerBps} bps incl. slippage, maker ${fee.makerBps} bps)`);
  console.log(`${"strategy".padEnd(26)}${"total".padStart(8)}${"per yr".padStart(8)}${"max DD".padStart(8)}${"up days".padStart(9)}${"flat".padStart(6)}${"down".padStart(6)}${"avg day".padStart(9)}${"worst day".padStart(11)}${"up months".padStart(11)}${"worst mo".padStart(10)}`);
  for (const st of STRATEGIES) {
    const perCoin = bars.map((b, s) => st.run(b, spans[s]!.from, spans[s]!.to, dailyBars[s]!, fee));
    const dayKeys = [...perCoin[0]!.keys()].filter((d) => perCoin.every((m) => m.has(d))).sort((a, b) => a - b);
    const equity = dayKeys.map((d) => perCoin.reduce((a, m) => a + m.get(d)! / 3, 0));
    const daily = equity.slice(1).map((v, k) => v - equity[k]!);
    let peak = 0, maxDD = 0; for (const v of equity) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); }
    const months = new Map<string, number[]>();
    dayKeys.forEach((d, k) => { const m = new Date(d * DAY).toISOString().slice(0, 7); months.set(m, [...(months.get(m) ?? []), equity[k]!]); });
    const monthRets = [...months.values()].map((v, k, all) => (k + 1 < all.length ? all[k + 1]![0]! : v.at(-1)!) / v[0]! - 1);
    const years = dayKeys.length / 365.25, final = equity.at(-1)!;
    const eps = 1e-6; // a day with no position counts as flat
    const r = {
      fee: fee.name, strategy: st.name, total: final - 1, cagr: final ** (1 / years) - 1, maxDrawdown: maxDD,
      upDays: daily.filter((x) => x > eps).length / daily.length, flatDays: daily.filter((x) => Math.abs(x) <= eps).length / daily.length,
      downDays: daily.filter((x) => x < -eps).length / daily.length,
      avgDay: (daily.reduce((a, b) => a + b, 0) / daily.length) * 10_000, worstDay: Math.min(...daily) * 10_000,
      upMonths: monthRets.filter((x) => x > 0).length / monthRets.length, worstMonth: Math.min(...monthRets),
    };
    report.push(r);
    console.log(`${st.name.padEnd(26)}${pct(r.total).padStart(8)}${pct(r.cagr).padStart(8)}${pct(-r.maxDrawdown).padStart(8)}${`${Math.round(r.upDays * 100)}%`.padStart(9)}${`${Math.round(r.flatDays * 100)}%`.padStart(6)}${`${Math.round(r.downDays * 100)}%`.padStart(6)}${`$${r.avgDay.toFixed(2)}`.padStart(9)}${`$${r.worstDay.toFixed(0)}`.padStart(11)}${`${Math.round(r.upMonths * 100)}%`.padStart(11)}${pct(r.worstMonth).padStart(10)}`);
  }
}
mkdirSync("data/results", { recursive: true });
writeFileSync("data/results/daily.json", JSON.stringify(report, null, 2));
