import { ema, loadBars, resample, type Bars } from "./candles";
import { STRATEGY_PRESETS, type StrategyConfig } from "./strategy";

// Compare Core Strategy vs. 2 Offshoots:
// 1. Core (Baseline)
// 2. Core + Zero Extra Risk (5% Cash Yield + Maker Orders)
// 3. Core + Leverage (5% Cash Yield + Maker Orders + 1.25x Bull Leverage)

const DAY = 86_400_000, CAPITAL = 10_000, END = Date.UTC(2026, 8, 1);
const FROM_2022 = Date.UTC(2022, 0, 1);
const FROM_2021 = Date.UTC(2021, 7, 1);

const btc1m = loadBars("data/klines/BTCUSDT-1m-hist.csv");
const eth1m = loadBars("data/klines/ETHUSDT-1m-hist.csv");
const sol1m = loadBars("data/klines/SOLUSDT-1m-hist.csv");

const coins = ["BTC", "ETH", "SOL"];
const daily = [resample(btc1m, 1440), resample(eth1m, 1440), resample(sol1m, 1440)];
const coinDaily = daily.map((b, s) => ({ name: coins[s]!, b, e200: ema(b.c, 200) }));

interface StrategyVariant {
  name: string;
  shortName: string;
  config: StrategyConfig;
}

const VARIANTS: StrategyVariant[] = [
  { name: "New Core (Default: Yield + Maker + 1.25x Lev + Stops + Trim)", shortName: "New Core (+1.25x Lev)", config: STRATEGY_PRESETS.core },
  { name: "Core + 0 Risk (Upgraded: Unleveraged 1.0x + Stops + Trim)", shortName: "Core + 0 Risk (Unlev)", config: STRATEGY_PRESETS["core-zero-risk"] },
  { name: "Core Baseline (Original: 0% Yield, Taker, Flat 10% Stop, 1.0x)", shortName: "Core Baseline (Orig)", config: STRATEGY_PRESETS["core-baseline"] },
];


export interface VariantResult {
  name: string;
  final: number;
  pnl: number;
  totalPct: number;
  cagr: number;
  avgPerDay: number;
  maxDD: number;
  worstMonth: number;
  trades: number;
}

export function simulateVariant(v: StrategyVariant, from: number): VariantResult {
  const cfg = v.config;
  const startD = Math.floor(from / DAY);
  const endD = Math.floor(END / DAY);

  const positions = [0, 1, 2].map(() => ({
    qty: 0,
    peak: 0,
    stopped: false,
    stopPeak: 0,
    regimeOn: false,
    trimmedQty: 0,
    cash: CAPITAL / 3,
  }));

  const equityCurve: { d: number; v: number }[] = [];
  let trades = 0;
  const maker = cfg.makerBps / 1e4;
  const taker = cfg.takerBps / 1e4;
  const entryFee = cfg.makerEntry ? maker : taker;

  for (let day = startD; day < endD; day++) {
    // 1. Evaluate regime and trailing stops at yesterday's close
    const wantHold = [0, 1, 2].map((s) => {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
      if (k < 0) return false;
      const c = b.c[k]!;
      const pos = positions[s]!;
      const stopDistance = (cfg.assetTrailingStops && cfg.assetTrailingStops[coins[s]!]) ?? (cfg.trailingStop || 0.10);

      if (!pos.regimeOn && c > e200[k]! * 1.05) pos.regimeOn = true;
      else if (pos.regimeOn && c < e200[k]! * 0.95) pos.regimeOn = false;

      if (!pos.regimeOn) {
        pos.peak = 0;
        pos.stopped = false;
        pos.stopPeak = 0;
        pos.trimmedQty = 0;
      } else if (pos.stopped) {
        if (c > pos.stopPeak) {
          pos.stopped = false;
          pos.peak = c;
          pos.stopPeak = 0;
          pos.trimmedQty = 0;
        }
      } else {
        pos.peak = Math.max(pos.peak, c);
        if (c < pos.peak * (1 - stopDistance)) {
          pos.stopped = true;
          pos.stopPeak = pos.peak;
          pos.trimmedQty = 0;
        }
      }

      return pos.regimeOn && !pos.stopped;
    });

    // Check if macro bull regime
    const allBull = wantHold.every(Boolean);
    const btcPos = positions[0]!;
    const btcInBull = btcPos.regimeOn && !btcPos.stopped;
    const lev = allBull && cfg.bullLeverage ? cfg.bullLeverage : 1.0;

    // 2. Execute on today's open price
    for (let s = 0; s < 3; s++) {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k < 0) continue;
      const openPrice = b.o[k]!;
      const pos = positions[s]!;

      // Parabolic extension trimming
      if (cfg.parabolicTrim && wantHold[s] && pos.qty > 0) {
        const prevK = k - 1;
        if (prevK >= 0) {
          const stretch = b.c[prevK]! / e200[prevK]!;
          const stretchThresh = cfg.parabolicStretchThreshold ?? 1.60;
          if (stretch > stretchThresh && pos.trimmedQty === 0) {
            const trimFrac = cfg.parabolicTrimFraction ?? 0.25;
            const sellQty = pos.qty * trimFrac;
            const gross = sellQty * openPrice;
            pos.cash += gross * (1 - maker);
            pos.qty -= sellQty;
            pos.trimmedQty = sellQty;
            trades++;
          } else if (stretch < 1.30 && pos.trimmedQty > 0) {
            const buyAmt = pos.cash * 0.5;
            if (buyAmt > 10) {
              pos.qty += (buyAmt * (1 - entryFee)) / openPrice;
              pos.cash -= buyAmt;
              pos.trimmedQty = 0;
              trades++;
            }
          }
        }
      }

      if (!wantHold[s]) {
        // Must be in cash
        if (pos.qty > 0) {
          const gross = pos.qty * openPrice;
          const fee = gross * taker;
          pos.cash += gross - fee;
          pos.qty = 0;
          pos.trimmedQty = 0;
          trades++;
        }
      } else {
        const targetExposure = (pos.cash + pos.qty * openPrice) * lev;
        const currentExposure = pos.qty * openPrice;

        if (pos.qty === 0 && pos.cash > 0) {
          const investAmt = pos.cash * lev;
          const fee = investAmt * entryFee;
          pos.qty = (investAmt - fee) / openPrice;
          pos.cash = pos.cash * (1 - lev);
          trades++;
        } else if (lev !== 1.0 && Math.abs(targetExposure - currentExposure) > targetExposure * 0.05) {
          const diff = targetExposure - currentExposure;
          if (diff > 0) {
            const fee = diff * entryFee;
            pos.qty += (diff - fee) / openPrice;
            pos.cash -= diff;
            trades++;
          }
        } else if (lev === 1.0 && pos.cash < 0) {
          const debt = -pos.cash;
          pos.qty -= debt / openPrice;
          pos.cash = -(debt * taker);
          trades++;
        }
      }

      // Accrue cash yield or margin interest
      if (pos.cash > 0) {
        let apr = cfg.cashYieldApr || 0;
        if (cfg.bullCashYieldApr !== undefined && cfg.bearCashYieldApr !== undefined) {
          apr = btcInBull ? cfg.bullCashYieldApr : cfg.bearCashYieldApr;
        }
        if (apr > 0) {
          pos.cash += pos.cash * (apr / 365.25);
        }
      } else if (pos.cash < 0 && cfg.marginApr) {
        pos.cash -= (-pos.cash) * (cfg.marginApr / 365.25);
      }
    }

    // Daily equity tracking
    let dayEq = 0;
    for (let s = 0; s < 3; s++) {
      const { b } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k >= 0) dayEq += positions[s]!.cash + positions[s]!.qty * b.c[k]!;
    }
    equityCurve.push({ d: day, v: dayEq });
  }

  // Final liquidation
  let final = 0;
  for (let s = 0; s < 3; s++) {
    const { b } = coinDaily[s]!;
    const lastPrice = b.c[b.c.length - 1]!;
    const pos = positions[s]!;
    final += pos.cash + pos.qty * lastPrice * (1 - taker);
  }

  let peak = 0, maxDD = 0;
  for (const { v } of equityCurve) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
  }

  // Worst month calculation
  const months = new Map<string, number>();
  for (const { d, v } of equityCurve) {
    const m = new Date(d * DAY).toISOString().slice(0, 7);
    if (!months.has(m)) months.set(m, v);
  }
  const mv = [...months.values()];
  const monthRets = mv.map((v, i) => (i + 1 < mv.length ? mv[i + 1]! : final) / v - 1);
  const worstMonth = Math.min(...monthRets);

  const pnl = final - CAPITAL;
  const years = (END - from) / (365.25 * DAY);
  const cagr = (final / CAPITAL) ** (1 / years) - 1;
  const totalDays = (END - from) / DAY;
  const avgPerDay = pnl / totalDays;

  return {
    name: v.shortName,
    final,
    pnl,
    totalPct: pnl / CAPITAL,
    cagr,
    avgPerDay,
    maxDD,
    worstMonth,
    trades,
  };
}

const PERIODS = [
  { label: "Jan 2022 – Aug 2026 (Conservative 4.7y, Starts into Crash)", from: FROM_2022 },
  { label: "Aug 2021 – Aug 2026 (Full 5.1y Cycle, Includes 2021 Bull)", from: FROM_2021 },
];

for (const p of PERIODS) {
  console.log(`\n### ${p.label}\n`);
  console.log(`| Strategy | Ending Value | Total Profit ($) | Total Profit (%) | Annualized Return | Average $/Day | Max Drawdown | Worst Month | Trades |`);
  console.log(`| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`);
  for (const v of VARIANTS) {
    const r = simulateVariant(v, p.from);
    const pnlStr = `${r.pnl >= 0 ? "+" : ""}$${Math.round(r.pnl).toLocaleString()}`;
    const pctStr = `${r.totalPct >= 0 ? "+" : ""}${(r.totalPct * 100).toFixed(0)}%`;
    const cagrStr = `${r.cagr >= 0 ? "+" : ""}${(r.cagr * 100).toFixed(1)}%`;
    const ddStr = `-${(r.maxDD * 100).toFixed(1)}%`;
    const wmStr = `${(r.worstMonth * 100).toFixed(1)}%`;
    console.log(
      `| **${r.name}** | $${Math.round(r.final).toLocaleString()} | **${pnlStr}** | **${pctStr}** | ${cagrStr} | **$${r.avgPerDay.toFixed(2)}/day** | **${ddStr}** | ${wmStr} | ${r.trades} |`
    );
  }
}
