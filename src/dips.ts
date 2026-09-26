import { ema, indexAt, loadBars, resample, type Bars } from "./candles";

// Buy-the-dip study. A dip = price falls X% below its highest point in the last W minutes. We buy at the next minute's
// open (market order) and measure the return after H. One event per coin per 24h so overlapping dips don't double count.
// Compared against the average return of buying at any minute over the same H (the market's drift).

const SYMBOLS = ["BTC", "ETH", "SOL"];
const START = Date.UTC(2021, 7, 1), END = Date.UTC(2026, 8, 1);
const DROPS = [0.05, 0.1, 0.15];
const WINDOWS = [{ label: "1h", min: 60 }, { label: "24h", min: 1440 }];
const HORIZONS = [{ label: "1h", min: 60 }, { label: "1d", min: 1440 }, { label: "7d", min: 10080 }];
const COST_BPS = 2 * 40; // round trip at the Kraken $10k tier, taker both ways incl. slippage
const COOLDOWN = 1440;

/** Rolling max of highs over the prior `w` bars (monotonic deque). */
function rollingMax(h: Float64Array, w: number): Float64Array {
  const out = new Float64Array(h.length), dq: number[] = [];
  for (let i = 0; i < h.length; i++) {
    out[i] = dq.length ? h[dq[0]!]! : h[i]!;
    while (dq.length && h[dq.at(-1)!]! <= h[i]!) dq.pop();
    dq.push(i);
    while (dq[0]! <= i - w) dq.shift();
  }
  return out;
}

/** Regime (200d EMA, 5% buffer) from yesterday's daily close, looked up per minute. */
function regimeAt(b: Bars): (i: number) => boolean {
  const d = resample(b, 1440), e = ema(d.c, 200), on = new Map<number, boolean>();
  let r = false;
  for (let k = 0; k < d.c.length; k++) {
    on.set(d.t[k]! + 86_400_000, r);
    if (!r && d.c[k]! > e[k]! * 1.05) r = true; else if (r && d.c[k]! < e[k]! * 0.95) r = false;
  }
  return (i) => on.get(Math.floor(b.t[i]! / 86_400_000) * 86_400_000) ?? false;
}

type Row = { coin: string; regime: boolean; fwd: Record<string, number> };
const events = new Map<string, Row[]>();
const drift: Record<string, number[]> = Object.fromEntries(HORIZONS.map((h) => [h.label, []]));

for (const coin of SYMBOLS) {
  const b = loadBars(`data/klines/${coin}USDT-1m-hist.csv`);
  const from = indexAt(b, START), to = indexAt(b, END), regime = regimeAt(b);
  const maxH = Math.max(...HORIZONS.map((h) => h.min));
  for (let i = from; i < to - maxH; i += 997) for (const h of HORIZONS) drift[h.label]!.push(b.c[i + h.min]! / b.o[i + 1]! - 1);
  for (const w of WINDOWS) {
    const hi = rollingMax(b.h, w.min);
    for (const drop of DROPS) {
      const key = `${(drop * 100).toFixed(0)}% in ${w.label}`;
      const rows = events.get(key) ?? [];
      let last = -Infinity;
      for (let i = from + w.min; i < to - maxH - 1; i++) {
        if (i - last < COOLDOWN || b.l[i]! > hi[i]! * (1 - drop)) continue;
        last = i;
        const entry = b.o[i + 1]!;
        rows.push({ coin, regime: regime(i), fwd: Object.fromEntries(HORIZONS.map((h) => [h.label, b.c[i + h.min]! / entry - 1])) });
      }
      events.set(key, rows);
    }
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const bps = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 1e4)}`;
const baseline = Object.fromEntries(HORIZONS.map((h) => [h.label, mean(drift[h.label]!)]));
console.log(`\nBuy-the-dip · BTC/ETH/SOL · Aug 2021 – Aug 2026 · buy at next minute's open · returns in bps (100 bps = 1%)`);
console.log(`Round-trip cost at Kraken $10k tier: ${COST_BPS} bps. "any minute" = average return of buying at a random time.`);
console.log(`any minute: ${HORIZONS.map((h) => `${h.label} ${bps(baseline[h.label]!)}`).join(" · ")}\n`);
console.log(`${"dip".padEnd(14)}${"regime".padEnd(8)}${"n".padStart(5)}${HORIZONS.map((h) => `${`${h.label} avg`.padStart(10)}${"win".padStart(6)}${"t".padStart(6)}${"net".padStart(7)}`).join("")}`);
for (const [key, rows] of events) {
  for (const [label, subset] of [["all", rows], ["up", rows.filter((r) => r.regime)], ["down", rows.filter((r) => !r.regime)]] as const) {
    if (subset.length < 5) { console.log(`${key.padEnd(14)}${label.padEnd(8)}${String(subset.length).padStart(5)}   too few`); continue; }
    const cells = HORIZONS.map((h) => {
      const xs = subset.map((r) => r.fwd[h.label]!), m = mean(xs);
      const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
      const t = (m - baseline[h.label]!) / (sd / Math.sqrt(xs.length));
      return `${bps(m).padStart(10)}${`${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}%`.padStart(6)}${t.toFixed(1).padStart(6)}${bps(m - COST_BPS / 1e4).padStart(7)}`;
    });
    console.log(`${key.padEnd(14)}${label.padEnd(8)}${String(subset.length).padStart(5)}${cells.join("")}`);
  }
}
console.log(`\nt = how far the dip's average return is from "any minute", in standard errors (|t| ≥ 2 is roughly meaningful). net = avg − ${COST_BPS} bps cost.`);
