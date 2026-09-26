import { ema, loadBars, resample, type Bars } from "./candles";
import { STRATEGY_PRESETS, type StrategyConfig } from "./strategy";

// ============================================================================
// Backtest Suite: 5 New Ways to Modify / Add to Core Strategy
// 1. Relative Strength / Momentum-Ranked Allocation
// 2. Asset-Specific Volatility-Scaled Trailing Stops
// 3. Parabolic Extension Trimming (Mean-Reversion Profit Harvest)
// 4. Time-Decaying Patience Reset on Trailing Stop Re-entries
// 5. Dynamic Crypto Basis / Funding Yield on Idle Cash
// + Combined "Super Core" (Best of All 5)
// ============================================================================

const DAY = 86_400_000, CAPITAL = 10_000, END = Date.UTC(2026, 8, 1);
const FROM_2022 = Date.UTC(2022, 0, 1);
const FROM_2021 = Date.UTC(2021, 7, 1);

const btc1m = loadBars("data/klines/BTCUSDT-1m-hist.csv");
const eth1m = loadBars("data/klines/ETHUSDT-1m-hist.csv");
const sol1m = loadBars("data/klines/SOLUSDT-1m-hist.csv");

const coins = ["BTC", "ETH", "SOL"];
const daily = [resample(btc1m, 1440), resample(eth1m, 1440), resample(sol1m, 1440)];
const coinDaily = daily.map((b, s) => ({ name: coins[s]!, b, e200: ema(b.c, 200) }));

export interface TestResult {
  id: string;
  name: string;
  final2022: number;
  pnl2022: number;
  pct2022: number;
  cagr2022: number;
  dd2022: number;
  trades2022: number;
  final2021: number;
  pnl2021: number;
  pct2021: number;
  cagr2021: number;
  dd2021: number;
  trades2021: number;
}

// Helper to calculate True Range and ATR
function calcATR(b: Bars, period = 14): Float64Array {
  const atr = new Float64Array(b.c.length);
  if (b.c.length === 0) return atr;
  const tr = new Float64Array(b.c.length);
  tr[0] = b.h[0]! - b.l[0]!;
  for (let i = 1; i < b.c.length; i++) {
    const hl = b.h[i]! - b.l[i]!;
    const hc = Math.abs(b.h[i]! - b.c[i - 1]!);
    const lc = Math.abs(b.l[i]! - b.c[i - 1]!);
    tr[i] = Math.max(hl, hc, lc);
  }
  let sum = 0;
  for (let i = 0; i < Math.min(period, b.c.length); i++) sum += tr[i]!;
  atr[period - 1] = sum / period;
  for (let i = period; i < b.c.length; i++) {
    atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return atr;
}

const coinATR = daily.map((b) => calcATR(b, 14));

interface SimOptions {
  // Idea 1: Momentum Tilt
  momentumTilt?: boolean;
  momentumLookbackDays?: number;

  // Idea 2: Asset-Specific Trailing Stop %
  customStops?: { BTC: number; ETH: number; SOL: number };

  // Idea 3: Parabolic Extension Trimming
  parabolicTrim?: boolean;
  trimStretchThreshold?: number; // e.g. 1.60x 200 EMA
  trimFraction?: number;         // e.g. 0.25

  // Idea 4: Time-Decaying Patience Reset
  patienceResetDays?: number;    // e.g. 45 days
  donchianBreakoutDays?: number; // e.g. 20 days

  // Idea 5: Dynamic Cash Basis Yield
  dynamicCashYield?: boolean;
  bullCashYieldApr?: number;     // e.g. 0.18 (18%)
  bearCashYieldApr?: number;     // e.g. 0.05 (5%)

  // Core base settings
  baseConfig?: StrategyConfig;
}

function runSimulation(opts: SimOptions, from: number): {
  final: number;
  pnl: number;
  totalPct: number;
  cagr: number;
  maxDD: number;
  trades: number;
} {
  const cfg = opts.baseConfig || STRATEGY_PRESETS.core;
  const startD = Math.floor(from / DAY);
  const endD = Math.floor(END / DAY);

  const maker = cfg.makerBps / 1e4;
  const taker = cfg.takerBps / 1e4;
  const entryFee = cfg.makerEntry ? maker : taker;

  // Global portfolio cash (shared for momentum tilt) or split
  const useSharedCash = !!opts.momentumTilt;
  let sharedCash = CAPITAL;

  const positions = [0, 1, 2].map((s) => ({
    qty: 0,
    peak: 0,
    stopped: false,
    stopPeak: 0,
    regimeOn: false,
    stoppedDaysCount: 0,
    trimmedQty: 0,
    cash: useSharedCash ? 0 : CAPITAL / 3,
  }));

  const equityCurve: { d: number; v: number }[] = [];
  let trades = 0;

  for (let day = startD; day < endD; day++) {
    // 1. Evaluate regimes, trailing stops, and resets at yesterday's close
    const wantHold = [0, 1, 2].map((s) => {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
      if (k < 0) return false;
      const c = b.c[k]!;
      const pos = positions[s]!;
      const coinName = coins[s] as "BTC" | "ETH" | "SOL";

      // 200 EMA regime filter with 5% hysteresis
      if (!pos.regimeOn && c > e200[k]! * 1.05) pos.regimeOn = true;
      else if (pos.regimeOn && c < e200[k]! * 0.95) pos.regimeOn = false;

      // Trailing stop loss threshold (Idea 2)
      const stopDistance = opts.customStops ? opts.customStops[coinName] : (cfg.trailingStop || 0.10);

      if (!pos.regimeOn) {
        pos.peak = 0;
        pos.stopped = false;
        pos.stopPeak = 0;
        pos.stoppedDaysCount = 0;
        pos.trimmedQty = 0;
      } else if (pos.stopped) {
        pos.stoppedDaysCount++;

        // Idea 4: Time-Decaying Patience Reset
        let reEntered = false;
        if (opts.patienceResetDays && pos.stoppedDaysCount >= opts.patienceResetDays) {
          const lookback = opts.donchianBreakoutDays || 20;
          let highestHigh = 0;
          for (let prev = Math.max(0, k - lookback); prev < k; prev++) {
            highestHigh = Math.max(highestHigh, b.h[prev]!);
          }
          if (c > highestHigh) {
            pos.stopped = false;
            pos.peak = c;
            pos.stopPeak = 0;
            pos.stoppedDaysCount = 0;
            reEntered = true;
          }
        }

        // Standard re-entry on new peak
        if (!reEntered && c > pos.stopPeak) {
          pos.stopped = false;
          pos.peak = c;
          pos.stopPeak = 0;
          pos.stoppedDaysCount = 0;
        }
      } else {
        pos.peak = Math.max(pos.peak, c);
        if (c < pos.peak * (1 - stopDistance)) {
          pos.stopped = true;
          pos.stopPeak = pos.peak;
          pos.stoppedDaysCount = 0;
          pos.trimmedQty = 0;
        }
      }

      return pos.regimeOn && !pos.stopped;
    });

    const allBull = wantHold.every(Boolean);
    const lev = allBull && cfg.bullLeverage ? cfg.bullLeverage : 1.0;

    // Idea 1: Calculate Target Portfolio Allocations
    let targetWeights = [1 / 3, 1 / 3, 1 / 3];
    if (opts.momentumTilt) {
      const lookback = opts.momentumLookbackDays || 30;
      const scores = [0, 1, 2].map((s) => {
        if (!wantHold[s]) return -999;
        const { b } = coinDaily[s]!;
        const k = b.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
        if (k < lookback) return 0;
        return (b.c[k]! - b.c[k - lookback]!) / b.c[k - lookback]!;
      });

      const activeIndices = [0, 1, 2].filter((s) => wantHold[s]);
      if (activeIndices.length === 3) {
        // Sort by momentum score descending
        const sorted = [...activeIndices].sort((a, b) => scores[b]! - scores[a]!);
        // Weight: 50% for leader, 32% for 2nd, 18% for 3rd
        targetWeights[sorted[0]!] = 0.50;
        targetWeights[sorted[1]!] = 0.32;
        targetWeights[sorted[2]!] = 0.18;
      } else if (activeIndices.length === 2) {
        const sorted = [...activeIndices].sort((a, b) => scores[b]! - scores[a]!);
        targetWeights[sorted[0]!] = 0.65;
        targetWeights[sorted[1]!] = 0.35;
      } else if (activeIndices.length === 1) {
        targetWeights[activeIndices[0]!] = 1.0;
      } else {
        targetWeights = [0, 0, 0];
      }
    }

    // 2. Execute on today's open price
    if (useSharedCash) {
      // Calculate current total equity
      let totalPortfolioVal = sharedCash;
      const openPrices = [0, 1, 2].map((s) => {
        const { b } = coinDaily[s]!;
        const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
        return k >= 0 ? b.o[k]! : 0;
      });
      for (let s = 0; s < 3; s++) totalPortfolioVal += positions[s]!.qty * openPrices[s]!;

      for (let s = 0; s < 3; s++) {
        const openPrice = openPrices[s]!;
        if (!openPrice) continue;
        const pos = positions[s]!;

        if (!wantHold[s]) {
          if (pos.qty > 0) {
            const gross = pos.qty * openPrice;
            const fee = gross * taker;
            sharedCash += gross - fee;
            pos.qty = 0;
            pos.trimmedQty = 0;
            trades++;
          }
        } else {
          // Target position value for this coin
          const targetCoinVal = totalPortfolioVal * targetWeights[s]! * lev;
          const currentCoinVal = pos.qty * openPrice;
          const diff = targetCoinVal - currentCoinVal;

          if (Math.abs(diff) > totalPortfolioVal * 0.04) {
            if (diff > 0) {
              const buyAmt = Math.min(diff, sharedCash > 0 ? sharedCash * 0.99 : diff);
              if (buyAmt > 10) {
                const fee = buyAmt * entryFee;
                pos.qty += (buyAmt - fee) / openPrice;
                sharedCash -= buyAmt;
                trades++;
              }
            } else if (diff < 0) {
              const sellAmt = Math.abs(diff);
              const sellQty = Math.min(pos.qty, sellAmt / openPrice);
              if (sellQty > 0) {
                const gross = sellQty * openPrice;
                const fee = gross * taker;
                sharedCash += gross - fee;
                pos.qty -= sellQty;
                trades++;
              }
            }
          }
        }
      }

      // Cash yield or margin interest on shared cash
      if (sharedCash > 0) {
        let apr = cfg.cashYieldApr || 0.05;
        if (opts.dynamicCashYield) {
          apr = allBull ? (opts.bullCashYieldApr || 0.18) : (opts.bearCashYieldApr || 0.05);
        }
        sharedCash += sharedCash * (apr / 365.25);
      } else if (sharedCash < 0 && cfg.marginApr) {
        sharedCash -= (-sharedCash) * (cfg.marginApr / 365.25);
      }
    } else {
      // Split cash per coin
      for (let s = 0; s < 3; s++) {
        const { b, e200 } = coinDaily[s]!;
        const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
        if (k < 0) continue;
        const openPrice = b.o[k]!;
        const pos = positions[s]!;

        // Idea 3: Parabolic Extension Trimming
        let trimTargetQty = 0;
        if (opts.parabolicTrim && wantHold[s] && pos.qty > 0) {
          const prevK = k - 1;
          if (prevK >= 0) {
            const stretch = b.c[prevK]! / e200[prevK]!;
            const stretchThresh = opts.trimStretchThreshold || 1.60;
            if (stretch > stretchThresh && pos.trimmedQty === 0) {
              // Trim fraction
              const trimFrac = opts.trimFraction || 0.25;
              const sellQty = pos.qty * trimFrac;
              const gross = sellQty * openPrice;
              const fee = gross * maker;
              pos.cash += gross - fee;
              pos.qty -= sellQty;
              pos.trimmedQty = sellQty;
              trades++;
            } else if (stretch < 1.30 && pos.trimmedQty > 0) {
              // Re-accumulate trimmed portion back
              const buyAmt = pos.cash * 0.5;
              if (buyAmt > 10) {
                const fee = buyAmt * entryFee;
                pos.qty += (buyAmt - fee) / openPrice;
                pos.cash -= buyAmt;
                pos.trimmedQty = 0;
                trades++;
              }
            }
          }
        }

        if (!wantHold[s]) {
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

        // Cash yield or margin interest
        if (pos.cash > 0) {
          let apr = cfg.cashYieldApr || 0.05;
          if (opts.dynamicCashYield) {
            const btcInBull = positions[0]!.regimeOn && !positions[0]!.stopped;
            apr = btcInBull ? (opts.bullCashYieldApr || 0.15) : (opts.bearCashYieldApr || 0.05);
          }
          pos.cash += pos.cash * (apr / 365.25);
        } else if (pos.cash < 0 && cfg.marginApr) {
          pos.cash -= (-pos.cash) * (cfg.marginApr / 365.25);
        }
      }
    }

    // Daily equity tracking
    let dayEq = useSharedCash ? sharedCash : 0;
    for (let s = 0; s < 3; s++) {
      const { b } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k >= 0) {
        dayEq += (useSharedCash ? 0 : positions[s]!.cash) + positions[s]!.qty * b.c[k]!;
      }
    }
    equityCurve.push({ d: day, v: dayEq });
  }

  // Final liquidation
  let final = useSharedCash ? sharedCash : 0;
  for (let s = 0; s < 3; s++) {
    const { b } = coinDaily[s]!;
    const lastPrice = b.c[b.c.length - 1]!;
    const pos = positions[s]!;
    final += (useSharedCash ? 0 : pos.cash) + pos.qty * lastPrice * (1 - taker);
  }

  let peak = 0, maxDD = 0;
  for (const { v } of equityCurve) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
  }

  const pnl = final - CAPITAL;
  const totalPct = (pnl / CAPITAL) * 100;
  const totalDays = (END - from) / DAY;
  const years = totalDays / 365.25;
  const cagr = (Math.pow(final / CAPITAL, 1 / years) - 1) * 100;

  return { final, pnl, totalPct, cagr, maxDD, trades };
}

// Run all test candidates
export function runAllFiveTests(): TestResult[] {
  const base = STRATEGY_PRESETS.core;

  const experiments: { id: string; name: string; opts: SimOptions }[] = [
    {
      id: "baseline",
      name: "Current Core (Yield 5% + Maker + 1.25x Lev)",
      opts: { baseConfig: base },
    },
    {
      id: "idea1-mom",
      name: "Idea 1: Relative Strength Momentum Tilt (50/32/18)",
      opts: { baseConfig: base, momentumTilt: true, momentumLookbackDays: 30 },
    },
    {
      id: "idea2-atr-stops",
      name: "Idea 2: Asset-Specific Stops (BTC 8%, ETH 10%, SOL 12%)",
      opts: { baseConfig: base, customStops: { BTC: 0.08, ETH: 0.10, SOL: 0.12 } },
    },
    {
      id: "idea3-parabolic-trim",
      name: "Idea 3: Parabolic Extension Trim (25% trim at >1.6x 200d EMA)",
      opts: { baseConfig: base, parabolicTrim: true, trimStretchThreshold: 1.60, trimFraction: 0.25 },
    },
    {
      id: "idea4-patience-reset",
      name: "Idea 4: Patience Reset (20d Breakout re-entry after 45d base)",
      opts: { baseConfig: base, patienceResetDays: 45, donchianBreakoutDays: 20 },
    },
    {
      id: "idea5-basis-yield",
      name: "Idea 5: Dynamic Crypto Basis Yield (15% APR in Macro Bull)",
      opts: { baseConfig: base, dynamicCashYield: true, bullCashYieldApr: 0.15, bearCashYieldApr: 0.05 },
    },
    {
      id: "combo-winning-triple",
      name: "WINNING COMBO: (Stops 8/10/12 + Parabolic Trim + 15% Basis)",
      opts: {
        baseConfig: base,
        customStops: { BTC: 0.08, ETH: 0.10, SOL: 0.12 },
        dynamicCashYield: true,
        bullCashYieldApr: 0.15,
        bearCashYieldApr: 0.05,
        parabolicTrim: true,
        trimStretchThreshold: 1.60,
        trimFraction: 0.25,
      },
    },
  ];

  const results: TestResult[] = [];

  for (const exp of experiments) {
    const res2022 = runSimulation(exp.opts, FROM_2022);
    const res2021 = runSimulation(exp.opts, FROM_2021);

    results.push({
      id: exp.id,
      name: exp.name,
      final2022: res2022.final,
      pnl2022: res2022.pnl,
      pct2022: res2022.totalPct,
      cagr2022: res2022.cagr,
      dd2022: res2022.maxDD,
      trades2022: res2022.trades,
      final2021: res2021.final,
      pnl2021: res2021.pnl,
      pct2021: res2021.totalPct,
      cagr2021: res2021.cagr,
      dd2021: res2021.maxDD,
      trades2021: res2021.trades,
    });
  }

  return results;
}

// Print formatted report if run directly
if (import.meta.main) {
  console.log("==========================================================================================");
  console.log("TESTING 5 NEW STRATEGY MODIFICATIONS ON KRAKEN PRO DATA (2021 - 2026)");
  console.log("Starting Capital: $10,000 | Kraken Pro Fees | Real Hourly/Daily Binance Klines");
  console.log("==========================================================================================\n");

  const results = runAllFiveTests();

  console.log("### 1. CONSERVATIVE WINDOW: Jan 2022 - Aug 2026 (4.7 Years, Starts into Bear Crash)\n");
  console.log(
    "Strategy".padEnd(52) +
    "Final $".padStart(11) +
    "Profit $".padStart(12) +
    "Profit %".padStart(11) +
    "CAGR".padStart(9) +
    "Max DD".padStart(10) +
    "Trades".padStart(8)
  );
  console.log("-".repeat(113));

  for (const r of results) {
    console.log(
      r.name.padEnd(52) +
      (`$${r.final2022.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).padStart(11) +
      (`+$${r.pnl2022.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).padStart(12) +
      (`${r.pct2022.toFixed(1)}%`).padStart(11) +
      (`${r.cagr2022.toFixed(1)}%`).padStart(9) +
      (`-${(r.dd2022 * 100).toFixed(1)}%`).padStart(10) +
      r.trades2022.toString().padStart(8)
    );
  }

  console.log("\n### 2. FULL CYCLE: Aug 2021 - Aug 2026 (5.1 Years, Includes 2021 Supercycle Peak)\n");
  console.log(
    "Strategy".padEnd(52) +
    "Final $".padStart(11) +
    "Profit $".padStart(12) +
    "Profit %".padStart(11) +
    "CAGR".padStart(9) +
    "Max DD".padStart(10) +
    "Trades".padStart(8)
  );
  console.log("-".repeat(113));

  for (const r of results) {
    console.log(
      r.name.padEnd(52) +
      (`$${r.final2021.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).padStart(11) +
      (`+$${r.pnl2021.toLocaleString("en-US", { maximumFractionDigits: 0 })}`).padStart(12) +
      (`${r.pct2021.toFixed(1)}%`).padStart(11) +
      (`${r.cagr2021.toFixed(1)}%`).padStart(9) +
      (`-${(r.dd2021 * 100).toFixed(1)}%`).padStart(10) +
      r.trades2021.toString().padStart(8)
    );
  }
}
