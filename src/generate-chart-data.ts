import { ema, loadBars, resample, type Bars } from "./candles";
import { STRATEGY_PRESETS, type StrategyConfig } from "./strategy";
import { writeFileSync } from "node:fs";

const DAY = 86_400_000, CAPITAL = 10_000, END = Date.UTC(2026, 8, 1);
const FROM = Date.UTC(2021, 7, 1); // Aug 1, 2021

const btc1m = loadBars("data/klines/BTCUSDT-1m-hist.csv");
const eth1m = loadBars("data/klines/ETHUSDT-1m-hist.csv");
const sol1m = loadBars("data/klines/SOLUSDT-1m-hist.csv");

const coins = ["BTC", "ETH", "SOL"] as const;
type Coin = typeof coins[number];

const daily = [resample(btc1m, 1440), resample(eth1m, 1440), resample(sol1m, 1440)];
const coinDaily = daily.map((b, s) => ({ name: coins[s], b, e200: ema(b.c, 200) }));

export interface TradeMarker {
  id: number;
  timestamp: number;
  date: string;
  coin: Coin;
  action: "BUY" | "TRIM" | "STOP" | "REGIME_OFF";
  price: number;
  qty: number;
  gross: number;
  fee: number;
  pnlUsd?: number;
  pnlPct?: number;
  reason: string;
}

export interface MonthlyDataPoint {
  monthKey: string;      // "2021-08"
  timestamp: number;     // start of month
  btcPrice: number;
  ethPrice: number;
  solPrice: number;
  btcNormPct: number;    // normalized % from start
  ethNormPct: number;
  solNormPct: number;
  equity: number;
  equityPct: number;
  cash: number;
  monthPnl: number;
  monthPnlPct: number;
  isProfit: boolean;
  regime: { BTC: boolean; ETH: boolean; SOL: boolean; allBull: boolean };
}

export interface ChartDataset {
  summary: {
    startCapital: number;
    finalEquity: number;
    totalProfitUsd: number;
    totalProfitPct: number;
    cagr: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
  };
  monthly: MonthlyDataPoint[];
  dailySeries: {
    t: number;
    date: string;
    btc: number;
    eth: number;
    sol: number;
    equity: number;
    cash: number;
  }[];
  trades: TradeMarker[];
}

export function generateChartDataset(): ChartDataset {
  const cfg = STRATEGY_PRESETS.core;
  const startD = Math.floor(FROM / DAY);
  const endD = Math.floor(END / DAY);

  const maker = cfg.makerBps / 1e4;
  const taker = cfg.takerBps / 1e4;
  const entryFee = cfg.makerEntry ? maker : taker;

  const positions = [0, 1, 2].map(() => ({
    qty: 0,
    peak: 0,
    stopped: false,
    stopPeak: 0,
    regimeOn: false,
    trimmedQty: 0,
    cash: CAPITAL / 3,
    entryPrice: 0,
  }));

  const allTrades: TradeMarker[] = [];
  let tradeIdCounter = 1;
  const dailyEquity: { t: number; date: string; btc: number; eth: number; sol: number; equity: number; cash: number }[] = [];

  // Track initial prices for normalization
  const btcInitial = coinDaily[0]!.b.c[coinDaily[0]!.b.t.findIndex(t => Math.floor(t / DAY) === startD)] || 40000;
  const ethInitial = coinDaily[1]!.b.c[coinDaily[1]!.b.t.findIndex(t => Math.floor(t / DAY) === startD)] || 2500;
  const solInitial = coinDaily[2]!.b.c[coinDaily[2]!.b.t.findIndex(t => Math.floor(t / DAY) === startD)] || 35;

  for (let day = startD; day < endD; day++) {
    const dayTimestamp = day * DAY;
    const dateStr = new Date(dayTimestamp).toISOString().slice(0, 10);

    // 1. Evaluate regime and trailing stops at yesterday's close
    const wantHold = [0, 1, 2].map((s) => {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
      if (k < 0) return false;
      const c = b.c[k]!;
      const pos = positions[s]!;
      const coinName = coins[s]!;
      const stopDistance = (cfg.assetTrailingStops && cfg.assetTrailingStops[coinName]) ?? (cfg.trailingStop || 0.10);

      if (!pos.regimeOn && c > e200[k]! * 1.05) {
        pos.regimeOn = true;
      } else if (pos.regimeOn && c < e200[k]! * 0.95) {
        pos.regimeOn = false;
      }

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

    const allBull = wantHold.every(Boolean);
    const btcPos = positions[0]!;
    const btcInBull = btcPos.regimeOn && !btcPos.stopped;
    const lev = allBull && cfg.bullLeverage ? cfg.bullLeverage : 1.0;

    // 2. Execute trades at today's open price
    for (let s = 0; s < 3; s++) {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k < 0) continue;
      const openPrice = b.o[k]!;
      const pos = positions[s]!;
      const coinName = coins[s]!;

      // Parabolic trim check
      if (cfg.parabolicTrim && wantHold[s] && pos.qty > 0) {
        const prevK = k - 1;
        if (prevK >= 0) {
          const stretch = b.c[prevK]! / e200[prevK]!;
          const stretchThresh = cfg.parabolicStretchThreshold ?? 1.60;
          if (stretch > stretchThresh && pos.trimmedQty === 0) {
            const trimFrac = cfg.parabolicTrimFraction ?? 0.25;
            const sellQty = pos.qty * trimFrac;
            const gross = sellQty * openPrice;
            const fee = gross * maker;
            pos.cash += gross - fee;
            pos.qty -= sellQty;
            pos.trimmedQty = sellQty;

            const pnlUsd = (openPrice - pos.entryPrice) * sellQty - fee;
            const pnlPct = ((openPrice - pos.entryPrice) / pos.entryPrice) * 100;

            allTrades.push({
              id: tradeIdCounter++,
              timestamp: dayTimestamp,
              date: dateStr,
              coin: coinName,
              action: "TRIM",
              price: openPrice,
              qty: sellQty,
              gross,
              fee,
              pnlUsd,
              pnlPct,
              reason: `Parabolic trim (${stretch.toFixed(2)}x > 200d EMA)`,
            });
          } else if (stretch < 1.30 && pos.trimmedQty > 0) {
            const buyAmt = pos.cash * 0.5;
            if (buyAmt > 10) {
              const fee = buyAmt * entryFee;
              const buyQty = (buyAmt - fee) / openPrice;
              pos.qty += buyQty;
              pos.cash -= buyAmt;
              pos.trimmedQty = 0;
              allTrades.push({
                id: tradeIdCounter++,
                timestamp: dayTimestamp,
                date: dateStr,
                coin: coinName,
                action: "BUY",
                price: openPrice,
                qty: buyQty,
                gross: buyAmt,
                fee,
                reason: "Re-accumulate trimmed cash (reverted to trend)",
              });
            }
          }
        }
      }

      if (!wantHold[s]) {
        // Exit to cash
        if (pos.qty > 0) {
          const gross = pos.qty * openPrice;
          const fee = gross * taker;
          pos.cash += gross - fee;

          const pnlUsd = (openPrice - pos.entryPrice) * pos.qty - fee;
          const pnlPct = pos.entryPrice > 0 ? ((openPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
          const action = pos.regimeOn ? "STOP" : "REGIME_OFF";
          const reason = pos.regimeOn
            ? `Trailing stop triggered (-${((cfg.assetTrailingStops?.[coinName] || 0.10) * 100).toFixed(0)}% from peak)`
            : "Regime filter OFF (below 200d EMA)";

          allTrades.push({
            id: tradeIdCounter++,
            timestamp: dayTimestamp,
            date: dateStr,
            coin: coinName,
            action,
            price: openPrice,
            qty: pos.qty,
            gross,
            fee,
            pnlUsd,
            pnlPct,
            reason,
          });

          pos.qty = 0;
          pos.trimmedQty = 0;
          pos.entryPrice = 0;
        }
      } else {
        const targetExposure = (pos.cash + pos.qty * openPrice) * lev;
        const currentExposure = pos.qty * openPrice;

        if (pos.qty === 0 && pos.cash > 0) {
          const investAmt = pos.cash * lev;
          const fee = investAmt * entryFee;
          const qty = (investAmt - fee) / openPrice;
          pos.qty = qty;
          pos.cash = pos.cash * (1 - lev);
          pos.entryPrice = openPrice;

          allTrades.push({
            id: tradeIdCounter++,
            timestamp: dayTimestamp,
            date: dateStr,
            coin: coinName,
            action: "BUY",
            price: openPrice,
            qty,
            gross: investAmt,
            fee,
            reason: lev > 1 ? "Regime ON (1.25x Bull Leverage)" : "Regime ON entry",
          });
        } else if (lev !== 1.0 && Math.abs(targetExposure - currentExposure) > targetExposure * 0.05) {
          const diff = targetExposure - currentExposure;
          if (diff > 0) {
            const fee = diff * entryFee;
            const addedQty = (diff - fee) / openPrice;
            pos.qty += addedQty;
            pos.cash -= diff;
            allTrades.push({
              id: tradeIdCounter++,
              timestamp: dayTimestamp,
              date: dateStr,
              coin: coinName,
              action: "BUY",
              price: openPrice,
              qty: addedQty,
              gross: diff,
              fee,
              reason: "Scale to 1.25x Bull Leverage",
            });
          }
        } else if (lev === 1.0 && pos.cash < 0) {
          const debt = -pos.cash;
          const soldQty = debt / openPrice;
          pos.qty -= soldQty;
          pos.cash = -(debt * taker);
          allTrades.push({
            id: tradeIdCounter++,
            timestamp: dayTimestamp,
            date: dateStr,
            coin: coinName,
            action: "TRIM",
            price: openPrice,
            qty: soldQty,
            gross: debt,
            fee: debt * taker,
            reason: "De-leverage to 1.0x (Bull phase paused)",
          });
        }
      }

      // Cash yield or margin interest
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

    // Daily equity calculation
    let dayTotalEq = 0;
    let dayTotalCash = 0;
    const currentPrices = [0, 1, 2].map((s) => {
      const { b } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      return k >= 0 ? b.c[k]! : 0;
    });

    for (let s = 0; s < 3; s++) {
      dayTotalCash += positions[s]!.cash;
      dayTotalEq += positions[s]!.cash + positions[s]!.qty * currentPrices[s]!;
    }

    dailyEquity.push({
      t: dayTimestamp,
      date: dateStr,
      btc: currentPrices[0]!,
      eth: currentPrices[1]!,
      sol: currentPrices[2]!,
      equity: dayTotalEq,
      cash: dayTotalCash,
    });
  }

  // Final liquidation calculation
  let finalEquity = 0;
  for (let s = 0; s < 3; s++) {
    const { b } = coinDaily[s]!;
    const lastP = b.c[b.c.length - 1]!;
    finalEquity += positions[s]!.cash + positions[s]!.qty * lastP * (1 - taker);
  }

  // Aggregate into monthly data points
  const monthlyMap = new Map<string, {
    prices: { btc: number; eth: number; sol: number };
    equityStart: number;
    equityEnd: number;
    cashEnd: number;
    timestamp: number;
    regime: { BTC: boolean; ETH: boolean; SOL: boolean; allBull: boolean };
  }>();

  for (const d of dailyEquity) {
    const monthKey = d.date.slice(0, 7); // e.g. "2021-08"
    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, {
        prices: { btc: d.btc, eth: d.eth, sol: d.sol },
        equityStart: d.equity,
        equityEnd: d.equity,
        cashEnd: d.cash,
        timestamp: d.t,
        regime: { BTC: false, ETH: false, SOL: false, allBull: false },
      });
    }
    const m = monthlyMap.get(monthKey)!;
    m.equityEnd = d.equity;
    m.cashEnd = d.cash;
    m.prices = { btc: d.btc, eth: d.eth, sol: d.sol };
  }

  const monthly: MonthlyDataPoint[] = [];
  const entries = Array.from(monthlyMap.entries());

  for (let i = 0; i < entries.length; i++) {
    const [monthKey, data] = entries[i]!;
    const prevEq = i === 0 ? CAPITAL : entries[i - 1]![1].equityEnd;
    const monthPnl = data.equityEnd - prevEq;
    const monthPnlPct = (monthPnl / prevEq) * 100;

    monthly.push({
      monthKey,
      timestamp: data.timestamp,
      btcPrice: data.prices.btc,
      ethPrice: data.prices.eth,
      solPrice: data.prices.sol,
      btcNormPct: ((data.prices.btc - btcInitial) / btcInitial) * 100,
      ethNormPct: ((data.prices.eth - ethInitial) / ethInitial) * 100,
      solNormPct: ((data.prices.sol - solInitial) / solInitial) * 100,
      equity: data.equityEnd,
      equityPct: ((data.equityEnd - CAPITAL) / CAPITAL) * 100,
      cash: data.cashEnd,
      monthPnl,
      monthPnlPct,
      isProfit: monthPnl >= 0,
      regime: data.regime,
    });
  }

  // Summary stats
  let peak = 0, maxDD = 0;
  for (const d of dailyEquity) {
    peak = Math.max(peak, d.equity);
    maxDD = Math.max(maxDD, 1 - d.equity / peak);
  }

  const closedTrades = allTrades.filter(t => t.action === "STOP" || t.action === "REGIME_OFF" || t.action === "TRIM");
  const winningTrades = closedTrades.filter(t => (t.pnlUsd || 0) > 0).length;
  const losingTrades = closedTrades.filter(t => (t.pnlUsd || 0) <= 0).length;
  const winRate = closedTrades.length > 0 ? (winningTrades / closedTrades.length) * 100 : 0;
  const years = (END - FROM) / (DAY * 365.25);
  const totalProfitUsd = finalEquity - CAPITAL;
  const totalProfitPct = (totalProfitUsd / CAPITAL) * 100;
  const cagr = (Math.pow(finalEquity / CAPITAL, 1 / years) - 1) * 100;

  return {
    summary: {
      startCapital: CAPITAL,
      finalEquity,
      totalProfitUsd,
      totalProfitPct,
      cagr,
      maxDrawdownPct: maxDD * 100,
      winRate,
      totalTrades: allTrades.length,
      winningTrades,
      losingTrades,
    },
    monthly,
    dailySeries: dailyEquity.filter((_, i) => i % 5 === 0), // downsample daily series for fast rendering
    trades: allTrades,
  };
}

if (import.meta.main) {
  const data = generateChartDataset();
  writeFileSync("public/chart-data.json", JSON.stringify(data, null, 2));
  console.log(`Generated chart data with ${data.monthly.length} months and ${data.trades.length} trades.`);
  console.log(`Final Equity: $${data.summary.finalEquity.toFixed(2)} (+${data.summary.totalProfitPct.toFixed(1)}%) | Win Rate: ${data.summary.winRate.toFixed(1)}%`);
}
