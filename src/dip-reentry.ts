import { indexAt, loadBars, resample, type Bars } from "./candles";

// Backtest: Dip re-entry after trailing stop.
// When the 10% trailing stop fires, cash sits idle while waiting for price to exceed stopPeak.
// If a sharp dip (e.g. 5%/1h or 10%/24h) occurs while stopped out AND regime is still ON (uptrend):
// Strategy variations:
//   1. Baseline: wait for new high (close > stopPeak)
//   2. Dip un-stop: buy the dip (next minute open + crash slip), reset stop & ride the core position
//   3. Dip 24h trade: buy the dip with idle cash, exit after 24h (unless stopPeak reached)
//   4. Deep dip un-stop: 10%/24h dip
//   5. 5%/24h dip un-stop
//   6. Local high re-entry: re-enter on 10-day high instead of all-time stopPeak

const SYMBOLS = ["BTC", "ETH", "SOL"];
const DAY = 86_400_000, END = Date.UTC(2026, 8, 1), CAPITAL = 10_000;
const PERIODS = [
  { label: "Jan 2022 – Aug 2026", from: Date.UTC(2022, 0, 1) },
  { label: "Aug 2021 – Aug 2026", from: Date.UTC(2021, 7, 1) },
];
const FEES = [
  { name: "Kraken $10k+ tier", makerBps: 22, takerBps: 40 },
  { name: "Kraken new account", makerBps: 40, takerBps: 82 },
];
const SLIPS = [2, 50, 100]; // crash slippage in bps

type Mode =
  | "baseline"                      // wait for close > stopPeak
  | "dip-unstop-5p-1h"             // re-enter core on 5%/1h dip
  | "dip-unstop-10p-24h"           // re-enter core on 10%/24h dip
  | "dip-unstop-5p-24h"            // re-enter core on 5%/24h dip
  | "dip-trade-24h-5p-1h"          // 24h temporary trade on 5%/1h dip while stopped
  | "dip-trade-24h-10p-24h"        // 24h temporary trade on 10%/24h dip while stopped
  | "local-high-10d";              // re-enter on 10-day daily high instead of stopPeak

interface StrategyResult {
  pnl: number;
  final: number;
  cagr: number;
  maxDD: number;
  worstMonth: number;
  totalTrades: number;
  dipReentries: number;
  stopsFired: number;
}

const bars = SYMBOLS.map((s) => loadBars(`data/klines/${s}USDT-1m-hist.csv`));
const dailyBars = bars.map((b) => resample(b, 1440));

function runStrategy(
  mode: Mode,
  from: number,
  fee: (typeof FEES)[number],
  crashSlipBps: number
): StrategyResult {
  const dayEq = new Map<number, number>();
  let final = 0, totalTrades = 0, dipReentries = 0, stopsFired = 0;

  bars.forEach((b, s) => {
    const d = dailyBars[s]!;
    const start = indexAt(b, from), end = indexAt(b, END);
    const third = CAPITAL / 3;
    const taker = fee.takerBps / 1e4;
    const crashSlip = crashSlipBps / 1e4;

    let cash = third;
    let qty = 0;
    let active = false;
    let regimeOn = false;
    let peak = 0;
    let stopped = false;
    let stopPeak = 0;
    let emaVal: number | null = null;
    let lastDailyClose: number | null = null;

    // For temporary 24h dip trade while stopped
    let tempTrade = false;
    let tempTradeEntryT = 0;

    // Monotonic deque for rolling highs (1h = 60m, 24h = 1440m)
    const deque1h: [number, number][] = [];
    const deque24h: [number, number][] = [];

    // Daily close tracking
    let k = 0;

    for (let i = start; i < end; i++) {
      const barT = b.t[i]!, barO = b.o[i]!, barH = b.h[i]!, barL = b.l[i]!, barC = b.c[i]!;

      // Update 1h and 24h rolling max deque
      while (deque1h.length && deque1h.at(-1)![1] <= barH) deque1h.pop();
      deque1h.push([barT, barH]);
      while (deque1h[0]![0] <= barT - 60 * 60_000) deque1h.shift();

      while (deque24h.length && deque24h.at(-1)![1] <= barH) deque24h.pop();
      deque24h.push([barT, barH]);
      while (deque24h[0]![0] <= barT - 1440 * 60_000) deque24h.shift();

      // Check daily closes completed up to barT
      while (k < d.c.length && d.t[k]! + DAY <= barT) {
        const dt = d.t[k]!, dc = d.c[k]!;
        if (lastDailyClose === null || dt > lastDailyClose) {
          const a = 2 / (200 + 1);
          emaVal = emaVal === null ? dc : a * dc + (1 - a) * emaVal;
          if (!regimeOn && dc > emaVal * 1.05) regimeOn = true;
          else if (regimeOn && dc < emaVal * 0.95) regimeOn = false;

          if (!regimeOn) {
            peak = 0;
            stopped = false;
            stopPeak = 0;
            tempTrade = false;
          } else if (stopped) {
            if (mode === "local-high-10d") {
              // 10-day high re-entry
              const lookbackStart = Math.max(0, k - 10);
              let localHigh = 0;
              for (let j = lookbackStart; j < k; j++) localHigh = Math.max(localHigh, d.c[j]!);
              if (dc > localHigh) {
                stopped = false;
                peak = dc;
              }
            } else if (dc > stopPeak) {
              stopped = false;
              peak = dc;
            }
          } else {
            peak = Math.max(peak, dc);
            if (dc < peak * 0.9) {
              stopped = true;
              stopPeak = peak;
              stopsFired++;
            }
          }
          lastDailyClose = dt;
        }
        k++;
      }

      // Check temp trade exit if expired (24h)
      if (tempTrade && barT >= tempTradeEntryT + 1440 * 60_000) {
        // Exit temporary trade if still stopped (if stopped became false, it transitioned to core hold!)
        if (stopped) {
          const gross = qty * barO, feeAmt = gross * taker;
          cash += gross - feeAmt;
          qty = 0;
          totalTrades++;
          tempTrade = false;
        } else {
          tempTrade = false; // keep holding as core
        }
      }

      // Check dip re-entry triggers while stopped and regimeOn
      if (stopped && regimeOn && cash > 0 && !tempTrade) {
        const hi1h = deque1h[0]?.[1];
        const hi24h = deque24h[0]?.[1];

        let triggered = false;
        let isTemp = false;

        if (mode === "dip-unstop-5p-1h" && hi1h && barL <= hi1h * 0.95) {
          triggered = true;
        } else if (mode === "dip-unstop-10p-24h" && hi24h && barL <= hi24h * 0.90) {
          triggered = true;
        } else if (mode === "dip-unstop-5p-24h" && hi24h && barL <= hi24h * 0.95) {
          triggered = true;
        } else if (mode === "dip-trade-24h-5p-1h" && hi1h && barL <= hi1h * 0.95) {
          triggered = true;
          isTemp = true;
        } else if (mode === "dip-trade-24h-10p-24h" && hi24h && barL <= hi24h * 0.90) {
          triggered = true;
          isTemp = true;
        }

        if (triggered && i + 1 < end) {
          // Fill at next minute open + crash slip
          const nextO = b.o[i + 1]!;
          const price = nextO * (1 + crashSlip);
          const feeAmt = cash * taker;
          qty = (cash - feeAmt) / price;
          cash = 0;
          totalTrades++;
          dipReentries++;

          if (isTemp) {
            tempTrade = true;
            tempTradeEntryT = b.t[i + 1]!;
          } else {
            // Un-stop: re-enter core!
            stopped = false;
            peak = nextO; // reset peak to re-entry price for trailing stop
          }
        }
      }

      // Allowed to hold core?
      const allowed = regimeOn && !stopped;

      // Handle normal core exit / entry
      if (!allowed && !tempTrade) {
        if (qty > 0) {
          const gross = qty * barO, feeAmt = gross * taker;
          cash += gross - feeAmt;
          qty = 0;
          totalTrades++;
        }
        active = false;
      } else if (allowed && !tempTrade) {
        if (qty === 0 && cash > 0) {
          const feeAmt = cash * taker;
          qty = (cash - feeAmt) / barO;
          cash = 0;
          totalTrades++;
        }
        active = true;
      }

      // Equity tracking for daily stats
      const day = Math.floor(barT / DAY);
      if (!dayEq.has(day * 10 + s)) {
        dayEq.set(day * 10 + s, cash + qty * barO);
      }
    }

    const last = b.c[end - 1]!;
    final += (cash + qty * last) - qty * last * taker;
  });

  const days = [...new Set([...dayEq.keys()].map((x) => Math.floor(x / 10)))]
    .filter((x) => [0, 1, 2].every((s) => dayEq.has(x * 10 + s)))
    .sort((a, b) => a - b);
  const curve = days.map((x) => [0, 1, 2].reduce((a, s) => a + dayEq.get(x * 10 + s)!, 0));

  let peak = 0, maxDD = 0;
  for (const v of curve) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, 1 - v / peak);
  }

  const months = new Map<string, number>();
  days.forEach((x, i) => {
    const m = new Date(x * DAY).toISOString().slice(0, 7);
    if (!months.has(m)) months.set(m, curve[i]!);
  });
  const mv = [...months.values()];
  const monthRets = mv.map((v, i) => (i + 1 < mv.length ? mv[i + 1]! : final) / v - 1);
  const years = (END - from) / (365.25 * DAY);

  return {
    final,
    pnl: final - CAPITAL,
    cagr: (final / CAPITAL) ** (1 / years) - 1,
    maxDD,
    worstMonth: Math.min(...monthRets),
    totalTrades,
    dipReentries,
    stopsFired,
  };
}

const MODES: { mode: Mode; label: string }[] = [
  { mode: "baseline", label: "Baseline: wait for new high" },
  { mode: "dip-unstop-5p-1h", label: "Dip un-stop (5% in 1h)" },
  { mode: "dip-unstop-10p-24h", label: "Dip un-stop (10% in 24h)" },
  { mode: "dip-unstop-5p-24h", label: "Dip un-stop (5% in 24h)" },
  { mode: "dip-trade-24h-5p-1h", label: "Dip 24h trade (5% in 1h)" },
  { mode: "dip-trade-24h-10p-24h", label: "Dip 24h trade (10% in 24h)" },
  { mode: "local-high-10d", label: "Local high (10d high re-entry)" },
];

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;

for (const fee of FEES) {
  for (const period of PERIODS) {
    console.log(`\n================================================================================`);
    console.log(`Period: ${period.label} | Fee: ${fee.name} | Starting: $10,000`);
    console.log(`================================================================================`);
    console.log(
      `${"Strategy / Mode".padEnd(32)}${"Slip".padStart(7)}${"P&L".padStart(10)}${"Total".padStart(7)}${"Per yr".padStart(8)}${"Max DD".padStart(8)}${"Worst mo".padStart(10)}${"DipRe".padStart(8)}${"Trades".padStart(8)}`
    );
    for (const { mode, label } of MODES) {
      const slipsToTest = mode.startsWith("dip") ? SLIPS : [2];
      for (const slip of slipsToTest) {
        const r = runStrategy(mode, period.from, fee, slip);
        console.log(
          `${(slip === slipsToTest[0] ? label : "").padEnd(32)}${`${slip}bps`.padStart(7)}${money(r.pnl).padStart(10)}${pct(r.pnl / CAPITAL).padStart(7)}${pct(r.cagr).padStart(8)}${pct(-r.maxDD).padStart(8)}${pct(r.worstMonth).padStart(10)}${String(r.dipReentries).padStart(8)}${String(r.totalTrades).padStart(8)}`
        );
      }
    }
  }
}
