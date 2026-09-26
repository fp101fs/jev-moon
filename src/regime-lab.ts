import { loadBars, resample, ema, type Bars } from "./candles";

// Candidate improvements to the regime rule, on daily bars: the weight decided from day d's close is traded at
// day d+1's open. Each coin is a separate third of the portfolio. Every variant is reported, for two start dates.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const DAY = 86_400_000, END = Date.UTC(2026, 8, 1);
const PERIODS = [{ label: "Jan 2022 – Aug 2026", from: Date.UTC(2022, 0, 1) }, { label: "Aug 2021 – Aug 2026", from: Date.UTC(2021, 7, 1) }];
const FEES = [{ name: "$10k+ tier", bps: 40 }, { name: "new account", bps: 82 }];

const daily: Bars[] = SYMBOLS.map((s) => resample(loadBars(`data/klines/${s}USDT-1m-hist.csv`), 1440));

/** A variant returns, for each day, the target share of that coin's capital to hold after that day's close. */
type Variant = { name: string; weights: (b: Bars) => Float64Array };

/** Hysteresis regime: on above EMA × (1 + band), off below EMA × (1 − band). */
function regimeFlags(b: Bars, days: number, band: number): Uint8Array {
  const e = ema(b.c, days), out = new Uint8Array(b.c.length);
  let on = 0;
  for (let d = 0; d < b.c.length; d++) {
    if (!on && b.c[d]! > e[d]! * (1 + band)) on = 1; else if (on && b.c[d]! < e[d]! * (1 - band)) on = 0;
    out[d] = on;
  }
  return out;
}

function annualVol(b: Bars, lookback = 30): Float64Array {
  const out = new Float64Array(b.c.length);
  for (let d = lookback; d < b.c.length; d++) {
    let s = 0, s2 = 0;
    for (let k = d - lookback + 1; k <= d; k++) { const r = Math.log(b.c[k]! / b.c[k - 1]!); s += r; s2 += r * r; }
    out[d] = Math.sqrt(Math.max(0, s2 / lookback - (s / lookback) ** 2) * 365);
  }
  return out;
}

const base: Variant = { name: "current: 200d EMA, 5% buffer", weights: (b) => Float64Array.from(regimeFlags(b, 200, 0.05)) };

const VARIANTS: Variant[] = [
  base,
  // Average of five regime lengths: exposure steps in fifths, so no single length choice decides everything.
  { name: "ensemble 100–300d (fifths)", weights: (b) => {
    const flags = [100, 150, 200, 250, 300].map((n) => regimeFlags(b, n, 0.05));
    return Float64Array.from(b.c, (_, d) => flags.reduce((a, f) => a + f[d]!, 0) / flags.length);
  } },
  { name: "golden cross (50d > 200d EMA)", weights: (b) => { const f = ema(b.c, 50), s = ema(b.c, 200); return Float64Array.from(b.c, (_, d) => (f[d]! > s[d]! ? 1 : 0)); } },
  // Enter on the slow signal, leave on a faster one.
  { name: "enter 200d +5%, exit below 100d", weights: (b) => {
    const slow = ema(b.c, 200), fast = ema(b.c, 100), out = new Float64Array(b.c.length);
    let on = 0;
    for (let d = 0; d < b.c.length; d++) {
      if (!on && b.c[d]! > slow[d]! * 1.05) on = 1; else if (on && b.c[d]! < fast[d]!) on = 0;
      out[d] = on;
    }
    return out;
  } },
  // Trailing stop on top of the regime: exit after an X% fall from the high since entry; re-enter on a new high.
  ...[0.05, 0.07, 0.08, 0.1, 0.12, 0.15, 0.2, 0.3].map((x): Variant => ({ name: `current + ${Math.round(x * 100)}% trailing stop`, weights: (b) => {
    const flags = regimeFlags(b, 200, 0.05), out = new Float64Array(b.c.length);
    let peak = 0, stopped = false, stopPeak = 0;
    for (let d = 0; d < b.c.length; d++) {
      const c = b.c[d]!;
      if (!flags[d]) { peak = 0; stopped = false; out[d] = 0; continue; }
      if (stopped) { if (c > stopPeak) { stopped = false; peak = c; } else { out[d] = 0; continue; } }
      peak = Math.max(peak, c);
      if (c < peak * (1 - x)) { stopped = true; stopPeak = peak; out[d] = 0; continue; }
      out[d] = 1;
    }
    return out;
  } })),
  // Scale down when the coin is unusually volatile; only rebalance when the weight moves by 10+ points.
  ...[0.5, 0.6, 0.7, 0.8].map((target): Variant => ({ name: `current + vol target ${target * 100}%`, weights: (b) => {
    const flags = regimeFlags(b, 200, 0.05), vol = annualVol(b), out = new Float64Array(b.c.length);
    let w = 0;
    for (let d = 0; d < b.c.length; d++) {
      const want = flags[d] ? Math.min(1, target / Math.max(1e-9, vol[d]!)) : 0;
      if (Math.abs(want - w) >= 0.1 || want === 0 || (want === 1 && w < 1)) w = want;
      out[d] = w;
    }
    return out;
  } })),
];

function simulate(v: Variant, from: number, feeBps: number) {
  const fee = feeBps / 1e4;
  const perCoin = daily.map((b) => {
    const w = v.weights(b);
    const start = b.t.findIndex((t) => t >= from), found = b.t.findIndex((t) => t >= END), end = found < 0 ? b.t.length : found;
    const eq: number[] = [];
    let value = 1 / 3, held = 0, trades = 0;
    for (let d = start; d < end; d++) {
      // At the open of day d, move to the weight decided at yesterday's close; then hold through the day.
      const target = w[d - 1]!;
      if (Math.abs(target - held) > 1e-9) { value -= Math.abs(target - held) * value * fee; held = target; trades++; }
      eq.push(value);
      value *= 1 + held * (b.c[d]! / b.o[d]! - 1);
      if (d + 1 < end) value *= 1 + held * (b.o[d + 1]! / b.c[d]! - 1);
    }
    return { eq, final: value * (1 - held * fee), trades, days: b.t.slice(start, end) };
  });
  const n = Math.min(...perCoin.map((c) => c.eq.length));
  const curve = Array.from({ length: n }, (_, i) => perCoin.reduce((a, c) => a + c.eq[i]!, 0));
  const final = perCoin.reduce((a, c) => a + c.final, 0);
  let peak = 0, maxDD = 0; for (const x of curve) { peak = Math.max(peak, x); maxDD = Math.max(maxDD, 1 - x / peak); }
  const years = new Map<number, number>();
  perCoin[0]!.days.slice(0, n).forEach((t, i) => { const y = new Date(t).getUTCFullYear(); if (!years.has(y)) years.set(y, curve[i]!); });
  const ys = [...years.entries()];
  const yearly = ys.map(([y, v], i) => ({ y, r: (i + 1 < ys.length ? ys[i + 1]![1] : final) / v - 1 }));
  return { total: final - 1, cagr: final ** (365.25 / n) - 1, maxDD, worstYear: Math.min(...yearly.map((x) => x.r)), trades: perCoin.reduce((a, c) => a + c.trades, 0), coins: perCoin.map((c) => c.final * 3 - 1), yearly };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
const results: any[] = [];
for (const fee of FEES) for (const period of PERIODS) {
  console.log(`\n── ${period.label} · ${fee.name} (${fee.bps} bps per side incl. slippage) · $10,000 start`);
  console.log(`${"variant".padEnd(34)}${"P&L".padStart(10)}${"total".padStart(8)}${"per yr".padStart(8)}${"max DD".padStart(8)}${"worst yr".padStart(10)}${"trades".padStart(8)}   ${"BTC / ETH / SOL".padStart(20)}`);
  const baseRes = simulate(base, period.from, fee.bps);
  for (const v of VARIANTS) {
    const r = simulate(v, period.from, fee.bps);
    results.push({ variant: v.name, period: period.label, fee: fee.name, ...r });
    const better = v === base ? "" : `${r.total > baseRes.total ? "▲" : "▽"}${r.maxDD < baseRes.maxDD ? "▲" : "▽"}`;
    console.log(`${v.name.padEnd(34)}${`${r.total >= 0 ? "+" : "-"}$${Math.abs(Math.round(r.total * 10_000)).toLocaleString()}`.padStart(10)}${pct(r.total).padStart(8)}${pct(r.cagr).padStart(8)}${pct(-r.maxDD).padStart(8)}${pct(r.worstYear).padStart(10)}${String(r.trades).padStart(8)}   ${r.coins.map(pct).join(" / ").padStart(20)}  ${better}`);
  }
}
console.log(`\n▲▽ vs current: first mark = total return, second = max drawdown (▲ = better)`);
Bun.write("data/results/regime-lab.json", JSON.stringify(results, null, 2));
