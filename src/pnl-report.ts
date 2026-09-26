import { indexAt, loadBars, resample } from "./candles";
import { CoinStrategy, DEFAULT_CONFIG, newCoinState, type StrategyConfig } from "./strategy";

// Total P&L of the best candidates on $10,000, using the same strategy code as the bot.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const DAY = 86_400_000, CAPITAL = 10_000;
const FEES = [{ name: "Kraken new account", makerBps: 40, takerBps: 82 }, { name: "Kraken $10k+ tier", makerBps: 22, takerBps: 40 }, { name: "low-fee exchange", makerBps: 8, takerBps: 12 }];
const STRATS: { name: string; cfg: Partial<StrategyConfig> | null }[] = [
  { name: "regime + 10% stop (bot default)", cfg: { mode: "hold", trailingStop: 0.1 } },
  { name: "regime only (hold)", cfg: { mode: "hold", trailingStop: 0 } },
  { name: "grid 4% + regime", cfg: { mode: "grid", spacing: 0.04, trailingStop: 0 } },
  { name: "grid 4% + regime + 10% stop", cfg: { mode: "grid", spacing: 0.04, trailingStop: 0.1 } },
  { name: "buy & hold (comparison)", cfg: null },
];
const PERIODS = [{ label: "Jan 2022 – Aug 2026", from: Date.UTC(2022, 0, 1) }, { label: "Aug 2021 – Aug 2026", from: Date.UTC(2021, 7, 1) }];
const END = Date.UTC(2026, 8, 1);

const bars = SYMBOLS.map((s) => loadBars(`data/klines/${s}USDT-1m-hist.csv`));
const daily = bars.map((b) => resample(b, 1440));
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;

/** Portfolio equity at the start of each UTC day (plus a final liquidation value), summed over coins. */
function equityCurve(cfg: Partial<StrategyConfig> | null, fee: (typeof FEES)[number], start: number, capital: number) {
  const days = new Map<number, number>();
  let final = 0, trades = 0;
  bars.forEach((b, s) => {
    const from = indexAt(b, start), to = indexAt(b, END), perCoin = capital / 3;
    const mark = (i: number, v: number) => { const d = Math.floor(b.t[i]! / DAY); if (!days.has(d * 10 + s)) { days.set(d * 10 + s, v); } };
    if (!cfg) {
      const qty = perCoin * (1 - fee.takerBps / 1e4) / b.o[from]!;
      for (let i = from; i < to; i++) mark(i, qty * b.o[i]!);
      final += qty * b.c[to - 1]! * (1 - fee.takerBps / 1e4); trades += 2;
      return;
    }
    const coin = new CoinStrategy({ ...DEFAULT_CONFIG, ...cfg, makerBps: fee.makerBps, takerBps: fee.takerBps }, newCoinState(perCoin));
    const d = daily[s]!; let k = 0;
    for (let i = from; i < to; i++) {
      while (k < d.c.length && d.t[k]! + DAY <= b.t[i]!) { coin.onDailyClose(d.t[k]!, d.c[k]!); k++; }
      mark(i, coin.equity(b.o[i]!));
      trades += coin.onBar({ t: b.t[i]!, o: b.o[i]!, h: b.h[i]!, l: b.l[i]!, c: b.c[i]! }).length;
    }
    final += coin.equity(b.c[to - 1]!) - coin.quantity * b.c[to - 1]! * fee.takerBps / 1e4;
  });
  const dayKeys = [...new Set([...days.keys()].map((k) => Math.floor(k / 10)))].filter((d) => [0, 1, 2].every((s) => days.has(d * 10 + s))).sort((x, y) => x - y);
  return { curve: dayKeys.map((d) => ({ d, v: [0, 1, 2].reduce((a, s) => a + days.get(d * 10 + s)!, 0) })), final, trades };
}

type Curve = ReturnType<typeof equityCurve>;
/** Two independent half-size sub-accounts, never rebalanced against each other. */
const blend = (a: Curve, b: Curve): Curve => ({ curve: a.curve.map((p, i) => ({ d: p.d, v: p.v + b.curve[i]!.v })), final: a.final + b.final, trades: a.trades + b.trades });

function stats(c: Curve) {
  let peak = 0, maxDD = 0;
  for (const { v } of c.curve) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); }
  const firstOf = (key: (d: number) => string) => { const m = new Map<string, number>(); for (const { d, v } of c.curve) { const k = key(d); if (!m.has(k)) m.set(k, v); } return [...m.entries()]; };
  const periodRets = (entries: [string, number][]) => entries.map(([k, v], i) => ({ k, ret: (i + 1 < entries.length ? entries[i + 1]![1] : c.final) / v - 1 }));
  const months = periodRets(firstOf((d) => new Date(d * DAY).toISOString().slice(0, 7)));
  return { maxDD, worstMonth: Math.min(...months.map((m) => m.ret)), byYear: periodRets(firstOf((d) => new Date(d * DAY).toISOString().slice(0, 4))) };
}

for (const period of PERIODS) {
  const yrs = (END - period.from) / (365.25 * DAY);
  console.log(`\n══ ${period.label} (${yrs.toFixed(1)} years) · start $10,000 · BTC/ETH/SOL thirds · open positions sold at the end`);
  for (const fee of FEES) {
    console.log(`\n  ${fee.name} (maker ${fee.makerBps} / taker ${fee.takerBps} bps incl. slippage)`);
    const curves = Object.fromEntries(STRATS.map((st) => [st.name, equityCurve(st.cfg, fee, period.from, CAPITAL)]));
    const half = (cfg: Partial<StrategyConfig>) => equityCurve(cfg, fee, period.from, CAPITAL / 2);
    curves["50/50 regime + grid 4%"] = blend(half({ mode: "hold", trailingStop: 0 }), half({ mode: "grid", spacing: 0.04, trailingStop: 0 }));
    console.log(`  ${"strategy".padEnd(32)}${"end".padStart(9)}${"P&L".padStart(10)}${"total".padStart(7)}${"per yr".padStart(8)}${"max DD".padStart(8)}${"worst mo".padStart(10)}${"trades".padStart(8)}   by year`);
    for (const name of ["regime + 10% stop (bot default)", "regime only (hold)", "50/50 regime + grid 4%", "grid 4% + regime", "grid 4% + regime + 10% stop", "buy & hold (comparison)"]) {
      const c = curves[name]!, st = stats(c), pnl = c.final - CAPITAL;
      console.log(`  ${name.padEnd(32)}${money(c.final).padStart(9)}${((pnl >= 0 ? "+" : "") + money(pnl)).padStart(10)}${pct(pnl / CAPITAL).padStart(7)}${pct((c.final / CAPITAL) ** (1 / yrs) - 1).padStart(8)}${pct(-st.maxDD).padStart(8)}${pct(st.worstMonth).padStart(10)}${String(c.trades).padStart(8)}   ${st.byYear.map((x) => `${x.k} ${pct(x.ret)}`).join(" · ")}`);
    }
  }
}
