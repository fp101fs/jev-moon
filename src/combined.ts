import { indexAt, loadBars, resample } from "./candles";
import { CoinStrategy, DEFAULT_CONFIG, DEFAULT_DIP, DipSleeve, newCoinState, newDipState, type DipConfig } from "./strategy";

// Core (regime + 10% trailing stop) plus a dip sleeve that buys sharp drops during uptrends and sells 24h later.
// Both use the bot's strategy code. Each coin gets a third of the capital, split core / dip. Every variant is shown.

const SYMBOLS = ["BTC", "ETH", "SOL"];
const DAY = 86_400_000, END = Date.UTC(2026, 8, 1), CAPITAL = 10_000;
const PERIODS = [{ label: "Jan 2022 – Aug 2026", from: Date.UTC(2022, 0, 1) }, { label: "Aug 2021 – Aug 2026", from: Date.UTC(2021, 7, 1) }];
const FEES = [{ name: "Kraken $10k+ tier", makerBps: 22, takerBps: 40 }, { name: "Kraken new account", makerBps: 40, takerBps: 82 }];
const SLIPS = [2, 50, 100, 200];

interface Setup { name: string; dipShare: number; dip?: Partial<DipConfig> }
const SETUPS: Setup[] = [
  { name: "core only (current bot)", dipShare: 0 },
  { name: "80% core + 20% dip (5%/1h)", dipShare: 0.2 },
  { name: "70% core + 30% dip (5%/1h)", dipShare: 0.3 },
  { name: "70% core + 30% dip (10%/24h)", dipShare: 0.3, dip: { drop: 0.1, windowMin: 1440 } },
  { name: "dip sleeve alone (5%/1h)", dipShare: 1 },
];

const bars = SYMBOLS.map((s) => loadBars(`data/klines/${s}USDT-1m-hist.csv`));
const daily = bars.map((b) => resample(b, 1440));

function run(setup: Setup, from: number, fee: (typeof FEES)[number], crashSlipBps: number) {
  const dayEq = new Map<number, number>();
  let final = 0, dipTrades = 0, dipWins = 0, coreTrades = 0;
  bars.forEach((b, s) => {
    const start = indexAt(b, from), end = indexAt(b, END), third = CAPITAL / 3;
    const core = new CoinStrategy({ ...DEFAULT_CONFIG, mode: "hold", trailingStop: 0.1, makerBps: fee.makerBps, takerBps: fee.takerBps }, newCoinState(third * (1 - setup.dipShare)));
    const dip = new DipSleeve({ ...DEFAULT_DIP, ...setup.dip, takerBps: fee.takerBps, crashSlipBps }, newDipState(third * setup.dipShare));
    const d = daily[s]!; let k = 0, entryCash = 0;
    for (let i = start; i < end; i++) {
      while (k < d.c.length && d.t[k]! + DAY <= b.t[i]!) { core.onDailyClose(d.t[k]!, d.c[k]!); k++; }
      const bar = { t: b.t[i]!, o: b.o[i]!, h: b.h[i]!, l: b.l[i]!, c: b.c[i]! };
      const day = Math.floor(bar.t / DAY);
      if (!dayEq.has(day * 10 + s)) dayEq.set(day * 10 + s, core.equity(bar.o) + dip.equity(bar.o));
      coreTrades += core.onBar(bar).length;
      for (const f of dip.onBar(bar, core.state.regimeOn)) {
        if (f.kind === "dip-buy") entryCash = f.qty * f.price + f.fee;
        else { dipTrades++; if (f.cashAfter > entryCash) dipWins++; }
      }
    }
    const last = b.c[end - 1]!;
    final += core.equity(last) + dip.equity(last) - (core.quantity + dip.state.qty) * last * fee.takerBps / 1e4;
  });
  const days = [...new Set([...dayEq.keys()].map((x) => Math.floor(x / 10)))].filter((x) => [0, 1, 2].every((s) => dayEq.has(x * 10 + s))).sort((a, b) => a - b);
  const curve = days.map((x) => [0, 1, 2].reduce((a, s) => a + dayEq.get(x * 10 + s)!, 0));
  let peak = 0, maxDD = 0; for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); }
  const months = new Map<string, number>(); days.forEach((x, i) => { const m = new Date(x * DAY).toISOString().slice(0, 7); if (!months.has(m)) months.set(m, curve[i]!); });
  const mv = [...months.values()], monthRets = mv.map((v, i) => (i + 1 < mv.length ? mv[i + 1]! : final) / v - 1);
  const years = (END - from) / (365.25 * DAY);
  return { final, pnl: final - CAPITAL, cagr: (final / CAPITAL) ** (1 / years) - 1, maxDD, worstMonth: Math.min(...monthRets), dipTrades, dipWinRate: dipTrades ? dipWins / dipTrades : NaN, coreTrades };
}

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
for (const fee of FEES) for (const period of PERIODS) {
  console.log(`\n── ${period.label} · ${fee.name} · $10,000 start`);
  console.log(`${"setup".padEnd(30)}${"crash slip".padStart(11)}${"P&L".padStart(10)}${"total".padStart(7)}${"per yr".padStart(8)}${"max DD".padStart(8)}${"worst mo".padStart(10)}${"dip trades".padStart(12)}${"dip wins".padStart(10)}`);
  for (const setup of SETUPS) {
    for (const slip of setup.dipShare ? SLIPS : [2]) {
      const r = run(setup, period.from, fee, slip);
      console.log(`${(slip === SLIPS[0] || !setup.dipShare ? setup.name : "").padEnd(30)}${(setup.dipShare ? `${slip} bps` : "—").padStart(11)}${money(r.pnl).padStart(10)}${pct(r.pnl / CAPITAL).padStart(7)}${pct(r.cagr).padStart(8)}${pct(-r.maxDD).padStart(8)}${pct(r.worstMonth).padStart(10)}${String(r.dipTrades || "—").padStart(12)}${(r.dipTrades ? `${Math.round(r.dipWinRate * 100)}%` : "—").padStart(10)}`);
    }
  }
}
