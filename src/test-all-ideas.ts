import { readFileSync } from "node:fs";
import { ema, type Bars } from "./candles";

// Testing all strategy improvement ideas from STRATEGY_IMPROVEMENTS.md
// Periods: Jan 2022 – Aug 2026 (4.7y) and Aug 2021 – Aug 2026 (5.1y)
// Starting capital: $10,000

const DAY = 86_400_000, CAPITAL = 10_000, END = Date.UTC(2026, 8, 1);
const FROM_2022 = Date.UTC(2022, 0, 1);
const FROM_2021 = Date.UTC(2021, 7, 1);

function parseCsv(path: string): Bars {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const n = lines.length;
  const t = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const parts = lines[i]!.split(",");
    t[i] = Number(parts[0]);
    o[i] = Number(parts[1]);
    h[i] = Number(parts[2]);
    l[i] = Number(parts[3]);
    c[i] = Number(parts[4]);
  }
  return { t, o, h, l, c };
}

// Load daily bars
import { loadBars, resample } from "./candles";
const btc1m = loadBars("data/klines/BTCUSDT-1m-hist.csv");
const eth1m = loadBars("data/klines/ETHUSDT-1m-hist.csv");
const sol1m = loadBars("data/klines/SOLUSDT-1m-hist.csv");

const allCoinsMap: Record<string, Bars> = {
  BTC: resample(btc1m, 1440),
  ETH: resample(eth1m, 1440),
  SOL: resample(sol1m, 1440),
  BNB: parseCsv("data/klines/BNBUSDT-1d.csv"),
  DOGE: parseCsv("data/klines/DOGEUSDT-1d.csv"),
  ADA: parseCsv("data/klines/ADAUSDT-1d.csv"),
  AVAX: parseCsv("data/klines/AVAXUSDT-1d.csv"),
  LINK: parseCsv("data/klines/LINKUSDT-1d.csv"),
};

interface TestOptions {
  coins: string[];
  cashYieldApr: number;       // e.g. 0.05 = 5% APR on cash
  entryFeeBps: number;        // 40 bps taker or 22 bps maker
  exitFeeBps: number;         // 40 bps taker
  leverageMax: number;        // 1.0 = none, 1.25 = 1.25x in macro bull regime
  marginInterestApr: number;  // 0.06 = 6% APR on borrowed funds
}

function simulateUniverse(opt: TestOptions, from: number) {
  const coins = opt.coins;
  const numCoins = coins.length;
  const startD = Math.floor(from / DAY);
  const endD = Math.floor(END / DAY);

  const coinDaily = coins.map((c) => {
    const b = allCoinsMap[c]!;
    const e200 = ema(b.c, 200);
    return { name: c, b, e200 };
  });

  const positions = coins.map(() => ({
    qty: 0,
    peak: 0,
    stopped: false,
    stopPeak: 0,
    regimeOn: false,
    cash: CAPITAL / numCoins,
  }));

  const equityCurve: number[] = [];
  let totalTrades = 0;
  let totalYieldEarned = 0;
  let totalMarginInterestPaid = 0;

  for (let day = startD; day < endD; day++) {
    // 1. Evaluate regime & trailing stop on yesterday's close
    const wantHold = coins.map((_, s) => {
      const { b, e200 } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day - 1);
      if (k < 0) return false;

      const c = b.c[k]!;
      const pos = positions[s]!;

      if (!pos.regimeOn && c > e200[k]! * 1.05) pos.regimeOn = true;
      else if (pos.regimeOn && c < e200[k]! * 0.95) pos.regimeOn = false;

      if (!pos.regimeOn) {
        pos.peak = 0;
        pos.stopped = false;
        pos.stopPeak = 0;
      } else if (pos.stopped) {
        if (c > pos.stopPeak) {
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

      return pos.regimeOn && !pos.stopped;
    });

    // Check if macro bull regime (all coins active)
    const allBull = wantHold.every(Boolean);
    const leverageFactor = allBull ? opt.leverageMax : 1.0;

    // 2. Execute trading on today's open price
    for (let s = 0; s < numCoins; s++) {
      const { b } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k < 0) continue;
      const openPrice = b.o[k]!;
      const pos = positions[s]!;

      if (!wantHold[s]) {
        // Must be in cash
        if (pos.qty > 0) {
          const gross = pos.qty * openPrice;
          const fee = gross * (opt.exitFeeBps / 1e4);
          pos.cash += gross - fee;
          pos.qty = 0;
          totalTrades++;
        }
      } else {
        // Allowed to hold
        const targetExposure = (pos.cash + pos.qty * openPrice) * leverageFactor;
        const currentExposure = pos.qty * openPrice;

        if (pos.qty === 0 && pos.cash > 0) {
          // Entry
          const investAmt = pos.cash * leverageFactor;
          const fee = investAmt * (opt.entryFeeBps / 1e4);
          const buyCash = investAmt - fee;
          pos.qty = buyCash / openPrice;
          pos.cash = pos.cash * (1 - leverageFactor); // negative if leverage > 1.0 (borrowed)
          totalTrades++;
        } else if (leverageFactor !== 1.0 && Math.abs(targetExposure - currentExposure) > targetExposure * 0.05) {
          // Rebalance leverage
          const diff = targetExposure - currentExposure;
          if (diff > 0) {
            const fee = diff * (opt.entryFeeBps / 1e4);
            pos.qty += (diff - fee) / openPrice;
            pos.cash -= diff;
            totalTrades++;
          }
        } else if (leverageFactor === 1.0 && pos.cash < 0) {
          // De-leverage to 1.0x
          const debt = -pos.cash;
          const sellQty = debt / openPrice;
          const fee = debt * (opt.exitFeeBps / 1e4);
          pos.qty -= sellQty;
          pos.cash = -fee;
          totalTrades++;
        }
      }

      // Daily interest/yield
      if (pos.cash > 0 && opt.cashYieldApr > 0) {
        const yieldAmt = pos.cash * (opt.cashYieldApr / 365.25);
        pos.cash += yieldAmt;
        totalYieldEarned += yieldAmt;
      } else if (pos.cash < 0 && opt.marginInterestApr > 0) {
        const interestAmt = (-pos.cash) * (opt.marginInterestApr / 365.25);
        pos.cash -= interestAmt;
        totalMarginInterestPaid += interestAmt;
      }
    }

    // Daily equity
    let dayEq = 0;
    for (let s = 0; s < numCoins; s++) {
      const { b } = coinDaily[s]!;
      const k = b.t.findIndex((t) => Math.floor(t / DAY) === day);
      if (k >= 0) dayEq += posEquity(positions[s]!, b.c[k]!);
    }
    equityCurve.push(dayEq);
  }

  // Final liquidation
  let final = 0;
  for (let s = 0; s < numCoins; s++) {
    const { b } = coinDaily[s]!;
    const lastPrice = b.c[b.c.length - 1]!;
    const pos = positions[s]!;
    const gross = pos.qty * lastPrice;
    const fee = gross * (opt.exitFeeBps / 1e4);
    final += pos.cash + gross - fee;
  }

  let peak = 0, maxDD = 0;
  for (const v of equityCurve) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
  }

  const pnl = final - CAPITAL;
  const years = (END - from) / (365.25 * DAY);
  const cagr = (final / CAPITAL) ** (1 / years) - 1;

  return { pnl, final, cagr, maxDD, totalTrades, totalYieldEarned, totalMarginInterestPaid };
}

function posEquity(p: { cash: number; qty: number }, price: number) {
  return p.cash + p.qty * price;
}

const EXPERIMENTS: { name: string; opt: TestOptions }[] = [
  {
    name: "0. Baseline (BTC/ETH/SOL, 0% cash yield, taker fees, 1.0x)",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "1. Idea #1: Idle Cash Yield @ 4% APR",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0.04, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "2. Idea #1: Idle Cash Yield @ 5% APR",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0.05, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "3. Idea #6: Maker-First Entry Orders (22 bps vs 40 bps)",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0, entryFeeBps: 22, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "4. Idea #5: Macro Bull Leverage (1.25x when all coins trend)",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.25, marginInterestApr: 0.06 },
  },
  {
    name: "5. Idea #5: Macro Bull Leverage (1.50x when all coins trend)",
    opt: { coins: ["BTC", "ETH", "SOL"], cashYieldApr: 0, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.50, marginInterestApr: 0.06 },
  },
  {
    name: "6. Idea #4: 6-Coin Universe (BTC, ETH, SOL, BNB, DOGE, AVAX)",
    opt: { coins: ["BTC", "ETH", "SOL", "BNB", "DOGE", "AVAX"], cashYieldApr: 0, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "7. Idea #4: 8-Coin Universe (BTC, ETH, SOL, BNB, DOGE, ADA, AVAX, LINK)",
    opt: { coins: ["BTC", "ETH", "SOL", "BNB", "DOGE", "ADA", "AVAX", "LINK"], cashYieldApr: 0, entryFeeBps: 40, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "8. Power Combo: 6-Coins + 5% Cash Yield + Maker Orders",
    opt: { coins: ["BTC", "ETH", "SOL", "BNB", "DOGE", "AVAX"], cashYieldApr: 0.05, entryFeeBps: 22, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
  {
    name: "9. Power Combo: 8-Coins + 5% Cash Yield + Maker Orders",
    opt: { coins: ["BTC", "ETH", "SOL", "BNB", "DOGE", "ADA", "AVAX", "LINK"], cashYieldApr: 0.05, entryFeeBps: 22, exitFeeBps: 40, leverageMax: 1.0, marginInterestApr: 0.06 },
  },
];

for (const [from, label] of [[FROM_2022, "Jan 2022 – Aug 2026 (Conservative 4.7y)"], [FROM_2021, "Aug 2021 – Aug 2026 (Full 5.1y)"]] as const) {
  console.log(`\n========================================================================================`);
  console.log(`Period: ${label} | Starting Capital: $10,000 | Kraken Pro Fees`);
  console.log(`========================================================================================`);
  console.log(`${"Improvement Concept".padEnd(58)}${"Final".padStart(10)}${"P&L".padStart(10)}${"Total".padStart(8)}${"CAGR".padStart(8)}${"MaxDD".padStart(8)}${"Trades".padStart(8)}`);
  for (const exp of EXPERIMENTS) {
    const res = simulateUniverse(exp.opt, from);
    const pnlStr = `${res.pnl >= 0 ? "+" : ""}$${Math.round(res.pnl).toLocaleString()}`;
    console.log(`${exp.name.padEnd(58)}${`$${Math.round(res.final).toLocaleString()}`.padStart(10)}${pnlStr.padStart(10)}${`${Math.round(res.pnl / CAPITAL * 100)}%`.padStart(8)}${`${Math.round(res.cagr * 100)}%`.padStart(8)}${`-${Math.round(res.maxDD * 100)}%`.padStart(8)}${String(res.totalTrades).padStart(8)}`);
  }
}
