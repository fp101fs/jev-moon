import { indexAt, loadBars, resample, ema, type Bars } from "./candles";

// Optimization Lab: Testing Dynamic Allocation & Smarter Re-Entry
// Benchmark: Jan 2022 – Aug 2026, $10,000 capital, Kraken $10k+ tier fees (22 maker / 40 taker bps)

const SYMBOLS = ["BTC", "ETH", "SOL"];
const DAY = 86_400_000, CAPITAL = 10_000, END = Date.UTC(2026, 8, 1);
const FROM_2022 = Date.UTC(2022, 0, 1);
const FROM_2021 = Date.UTC(2021, 7, 1);
const TAKER = 40 / 1e4;

const bars = SYMBOLS.map((s) => loadBars(`data/klines/${s}USDT-1m-hist.csv`));
const daily = bars.map((b) => resample(b, 1440));

interface SimConfig {
  name: string;
  dynamicSharing: boolean;    // Pool capital among active coins (e.g. 50/50 if 2 active, 100% if 1 active)
  reentryMode: "peak" | "ema20" | "ema50" | "breakout20"; // Re-entry condition
}

function runLab(cfg: SimConfig, from: number) {
  // Precompute daily indicators
  const coinData = daily.map((d) => {
    const e200 = ema(d.c, 200);
    const e50 = ema(d.c, 50);
    const e20 = ema(d.c, 20);
    return { d, e200, e50, e20 };
  });

  const startD = Math.floor(from / DAY);
  const endD = Math.floor(END / DAY);

  // Daily portfolio simulation
  let cash = CAPITAL;
  const positions: { qty: number; peak: number; stopped: boolean; stopPeak: number; regimeOn: boolean }[] = [
    { qty: 0, peak: 0, stopped: false, stopPeak: 0, regimeOn: false },
    { qty: 0, peak: 0, stopped: false, stopPeak: 0, regimeOn: false },
    { qty: 0, peak: 0, stopped: false, stopPeak: 0, regimeOn: false },
  ];

  const equityCurve: number[] = [];
  let trades = 0;

  for (let day = startD; day < endD; day++) {
    // 1. Evaluate regime and stops at yesterday's close for each coin
    const wantActive: boolean[] = [false, false, false];

    for (let s = 0; s < 3; s++) {
      const { d, e200, e50, e20 } = coinData[s]!;
      const k = d.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
      if (k < 0) continue;

      const c = d.c[k]!;
      const pos = positions[s]!;

      // 200d regime update
      if (!pos.regimeOn && c > e200[k]! * 1.05) pos.regimeOn = true;
      else if (pos.regimeOn && c < e200[k]! * 0.95) pos.regimeOn = false;

      if (!pos.regimeOn) {
        pos.peak = 0;
        pos.stopped = false;
        pos.stopPeak = 0;
      } else if (pos.stopped) {
        // Re-entry logic
        let reenter = false;
        if (cfg.reentryMode === "peak" && c > pos.stopPeak) reenter = true;
        else if (cfg.reentryMode === "ema20" && c > e20[k]!) reenter = true;
        else if (cfg.reentryMode === "ema50" && c > e50[k]!) reenter = true;
        else if (cfg.reentryMode === "breakout20") {
          let high20 = 0;
          for (let j = Math.max(0, k - 20); j < k; j++) high20 = Math.max(high20, d.c[j]!);
          if (c > high20) reenter = true;
        }

        if (reenter) {
          pos.stopped = false;
          pos.peak = c;
        }
      } else {
        pos.peak = Math.max(pos.peak, c);
        if (c < pos.peak * 0.9) {
          pos.stopped = true;
          pos.stopPeak = pos.peak;
        }
      }

      wantActive[s] = pos.regimeOn && !pos.stopped;
    }

    // 2. Determine target weights
    const activeCount = wantActive.filter(Boolean).length;
    const targetWeights: number[] = [0, 0, 0];

    for (let s = 0; s < 3; s++) {
      if (wantActive[s]) {
        targetWeights[s] = cfg.dynamicSharing ? 1 / activeCount : 1 / 3;
      }
    }

    // 3. Trade at today's open price
    let portfolioValue = cash;
    const openPrices: number[] = [0, 0, 0];

    for (let s = 0; s < 3; s++) {
      const { d } = coinData[s]!;
      const k = d.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k >= 0) {
        openPrices[s] = d.o[k]!;
        portfolioValue += positions[s]!.qty * openPrices[s]!;
      }
    }

    // Rebalance / execute orders
    for (let s = 0; s < 3; s++) {
      if (openPrices[s] === 0) continue;
      const targetVal = portfolioValue * targetWeights[s]!;
      const currentVal = positions[s]!.qty * openPrices[s]!;
      const diffVal = targetVal - currentVal;

      if (Math.abs(diffVal) > portfolioValue * 0.05) { // rebalance if shifted > 5%
        if (diffVal > 0) {
          const buyCash = Math.min(cash, diffVal);
          const fee = buyCash * TAKER;
          const newQty = (buyCash - fee) / openPrices[s]!;
          positions[s]!.qty += newQty;
          cash -= buyCash;
          trades++;
        } else {
          const sellVal = Math.min(currentVal, -diffVal);
          const sellQty = sellVal / openPrices[s]!;
          const fee = sellVal * TAKER;
          positions[s]!.qty -= sellQty;
          cash += sellVal - fee;
          trades++;
        }
      }
    }

    // Record daily equity
    let currentEquity = cash;
    for (let s = 0; s < 3; s++) {
      const { d } = coinData[s]!;
      const k = d.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k >= 0) currentEquity += positions[s]!.qty * d.c[k]!;
    }
    equityCurve.push(currentEquity);
  }

  // Final liquidation
  let final = cash;
  for (let s = 0; s < 3; s++) {
    const d = daily[s]!;
    const lastPrice = d.c[d.c.length - 1]!;
    final += positions[s]!.qty * lastPrice * (1 - TAKER);
  }

  let peak = 0, maxDD = 0;
  for (const v of equityCurve) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
  }

  const pnl = final - CAPITAL;
  const years = (END - from) / (365.25 * DAY);
  const cagr = (final / CAPITAL) ** (1 / years) - 1;

  return { pnl, final, cagr, maxDD, trades };
}

const SETUPS: SimConfig[] = [
  { name: "1. Baseline (rigid 1/3, wait for peak)", dynamicSharing: false, reentryMode: "peak" },
  { name: "2. Dynamic Allocation (pool active coins)", dynamicSharing: true, reentryMode: "peak" },
  { name: "3. Smarter Re-entry (20d EMA recovery)", dynamicSharing: false, reentryMode: "ema20" },
  { name: "4. Smarter Re-entry (50d EMA recovery)", dynamicSharing: false, reentryMode: "ema50" },
  { name: "5. Smarter Re-entry (20d Breakout)", dynamicSharing: false, reentryMode: "breakout20" },
  { name: "6. Both: Dynamic + 20d EMA Re-entry", dynamicSharing: true, reentryMode: "ema20" },
  { name: "7. Both: Dynamic + 50d EMA Re-entry", dynamicSharing: true, reentryMode: "ema50" },
];

for (const [from, label] of [[FROM_2022, "Jan 2022 – Aug 2026 (Conservative 4.7y)"], [FROM_2021, "Aug 2021 – Aug 2026 (Full 5.1y)"]] as const) {
  console.log(`\n========================================================================`);
  console.log(`Period: ${label} | $10k Start | Kraken $10k+ Tier`);
  console.log(`========================================================================`);
  console.log(`${"Strategy Setup".padEnd(46)}${"Final".padStart(10)}${"P&L".padStart(10)}${"Total".padStart(8)}${"CAGR".padStart(8)}${"MaxDD".padStart(8)}${"Trades".padStart(8)}`);
  for (const s of SETUPS) {
    const res = runLab(s, from);
    const pnlStr = `${res.pnl >= 0 ? "+" : ""}$${Math.round(res.pnl).toLocaleString()}`;
    console.log(`${s.name.padEnd(46)}${`$${Math.round(res.final).toLocaleString()}`.padStart(10)}${pnlStr.padStart(10)}${`${Math.round(res.pnl / CAPITAL * 100)}%`.padStart(8)}${`${Math.round(res.cagr * 100)}%`.padStart(8)}${`-${Math.round(res.maxDD * 100)}%`.padStart(8)}${String(res.trades).padStart(8)}`);
  }
}
