import { readFileSync } from "node:fs";

// Long-only (spot) candle backtesting. A signal is decided on a bar's close and filled at the next bar's open,
// so no strategy can trade on a price it hasn't seen yet.

export interface Bars { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array }

export function loadBars(path: string): Bars {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const n = lines.length;
  const b: Bars = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) };
  lines.forEach((line, i) => {
    const [t, o, h, l, c] = line.split(",").map(Number);
    b.t[i] = t!; b.o[i] = o!; b.h[i] = h!; b.l[i] = l!; b.c[i] = c!;
  });
  return b;
}

/** Aggregates 1-minute bars into `minutes`-minute bars aligned to the clock. */
export function resample(b: Bars, minutes: number): Bars {
  if (minutes === 1) return b;
  const ms = minutes * 60_000;
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let bucket = -1;
  for (let i = 0; i < b.t.length; i++) {
    const k = Math.floor(b.t[i]! / ms);
    if (k !== bucket) { bucket = k; t.push(k * ms); o.push(b.o[i]!); h.push(b.h[i]!); l.push(b.l[i]!); c.push(b.c[i]!); continue; }
    const j = c.length - 1;
    h[j] = Math.max(h[j]!, b.h[i]!); l[j] = Math.min(l[j]!, b.l[i]!); c[j] = b.c[i]!;
  }
  return { t: Float64Array.from(t), o: Float64Array.from(o), h: Float64Array.from(h), l: Float64Array.from(l), c: Float64Array.from(c) };
}

export function indexAt(b: Bars, ms: number): number {
  let lo = 0, hi = b.t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (b.t[mid]! < ms) lo = mid + 1; else hi = mid; }
  return lo;
}

export function ema(x: Float64Array, n: number): Float64Array {
  const out = new Float64Array(x.length);
  const a = 2 / (n + 1);
  out[0] = x[0]!;
  for (let i = 1; i < x.length; i++) out[i] = a * x[i]! + (1 - a) * out[i - 1]!;
  return out;
}

// ── Signals: pos[i] = 1 means "be long after bar i closes" ────────────────────────────────────────

export type Signal = (b: Bars) => Uint8Array;

/** Long while the fast EMA is above the slow EMA. */
export const trend = (fast: number, slow: number): Signal => (b) => {
  const f = ema(b.c, fast), s = ema(b.c, slow), pos = new Uint8Array(b.c.length);
  for (let i = slow; i < b.c.length; i++) pos[i] = f[i]! > s[i]! ? 1 : 0;
  return pos;
};

/** Buy when price is k standard deviations below its n-bar mean; sell once it's back to the mean. */
export const meanReversion = (n: number, k: number): Signal => (b) => {
  const pos = new Uint8Array(b.c.length);
  let sum = 0, sumSq = 0, long = false;
  for (let i = 0; i < b.c.length; i++) {
    const x = b.c[i]!;
    sum += x; sumSq += x * x;
    if (i >= n) { const y = b.c[i - n]!; sum -= y; sumSq -= y * y; }
    if (i >= n - 1) {
      const mean = sum / n, sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
      const z = sd > 0 ? (x - mean) / sd : 0;
      if (!long && z < -k) long = true;
      else if (long && z >= 0) long = false;
    }
    pos[i] = long ? 1 : 0;
  }
  return pos;
};

/** Donchian breakout: buy a close above the prior n-bar high, sell a close below the prior n/2-bar low. */
export const breakout = (n: number): Signal => (b) => {
  const m = Math.max(2, Math.round(n / 2)), pos = new Uint8Array(b.c.length);
  let long = false;
  for (let i = n; i < b.c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) if (b.h[j]! > hi) hi = b.h[j]!;
    for (let j = i - m; j < i; j++) if (b.l[j]! < lo) lo = b.l[j]!;
    if (!long && b.c[i]! > hi) long = true;
    else if (long && b.c[i]! < lo) long = false;
    pos[i] = long ? 1 : 0;
  }
  return pos;
};

// ── Execution ──────────────────────────────────────────────────────────────────────────────────────

export interface RunResult {
  ret: number;          // net return on starting capital
  trades: number;       // completed round trips
  wins: number;         // round trips that made money after fees
  exposure: number;     // share of bars spent long
  maxDrawdown: number;
  fees: number;         // fees + slippage paid, as a share of starting capital
  holds: number[];      // bars held per round trip, for the random baseline
}

/** Runs a position series over bars [from, to). Costs are per side, in bps of the traded notional. */
export function runPositions(b: Bars, pos: Uint8Array, costBps: number, from = 1, to = b.c.length): RunResult {
  const cost = costBps / 10_000;
  let eq = 1, peak = 1, maxDrawdown = 0, long = false, entryEq = 1, entryIdx = 0, trades = 0, wins = 0, exposed = 0, fees = 0;
  const holds: number[] = [];
  const start = Math.max(1, from);
  for (let i = start; i < to; i++) {
    if (long) eq *= b.o[i]! / b.c[i - 1]!;
    const want = i > start ? pos[i - 1] === 1 : false; // nothing carried in from before the window
    if (want !== long) {
      const fee = eq * cost; eq -= fee; fees += fee;
      if (want) { entryEq = eq + fee; entryIdx = i; }
      else { trades++; if (eq > entryEq) wins++; holds.push(i - entryIdx); }
      long = want;
    }
    if (long) { eq *= b.c[i]! / b.o[i]!; exposed++; }
    peak = Math.max(peak, eq); maxDrawdown = Math.max(maxDrawdown, 1 - eq / peak);
  }
  if (long) { const fee = eq * cost; eq -= fee; fees += fee; trades++; if (eq > entryEq) wins++; holds.push(to - entryIdx); }
  return { ret: eq - 1, trades, wins, exposure: exposed / Math.max(1, to - start), maxDrawdown, fees, holds };
}

/** Same number of trades with the same holding lengths as `holds`, but placed at random times in [from, to). */
export function randomPositions(n: number, from: number, to: number, holds: number[], rng: () => number): Uint8Array {
  const order = [...holds];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const free = Math.max(0, to - from - order.reduce((a, b) => a + b, 0));
  const cuts = order.map(() => Math.floor(rng() * (free + 1))).sort((a, b) => a - b);
  const held = new Uint8Array(n);
  let cursor = from, prevCut = 0;
  order.forEach((len, k) => {
    cursor += cuts[k]! - prevCut; prevCut = cuts[k]!;
    for (let j = 0; j < len && cursor + j < to; j++) held[cursor + j] = 1;
    cursor += len;
  });
  const pos = new Uint8Array(n); // pos[i] is filled at bar i + 1
  for (let i = from + 1; i < to; i++) pos[i - 1] = held[i]!;
  return pos;
}

/**
 * Grid trading with resting limit orders, so it pays maker fees. Capital is split into `units` equal slots. Each drop
 * of `spacing` below the last fill buys a slot; each rise of `spacing` above it sells the most recent slot. When fully
 * in cash and price runs away upward, the grid re-centres. One fill per bar; if a bar touches both a buy and a sell
 * level we assume the buy happened and skip the sell, which can only understate the grid.
 */
export function runGrid(b: Bars, spacing: number, units: number, makerBps: number, from = 0, to = b.c.length): RunResult {
  const fee = makerBps / 10_000, slot = 1 / units;
  let cash = 1, qty = 0, level = b.c[from]!, peak = 1, maxDrawdown = 0, trades = 0, wins = 0, exposedSum = 0, fees = 0;
  const lots: { qty: number; cost: number; at: number }[] = [];
  const holds: number[] = [];
  for (let i = from + 1; i < to; i++) {
    const buyAt = level * (1 - spacing), sellAt = level * (1 + spacing);
    if (b.l[i]! <= buyAt && lots.length < units && cash >= slot * 0.999) {
      const q = (slot * (1 - fee)) / buyAt;
      qty += q; cash -= slot; fees += slot * fee;
      lots.push({ qty: q, cost: slot, at: i });
      level = buyAt;
    } else if (b.h[i]! >= sellAt && lots.length) {
      const lot = lots.pop()!;
      const gross = lot.qty * sellAt, proceeds = gross * (1 - fee);
      qty -= lot.qty; cash += proceeds; fees += gross * fee;
      trades++; if (proceeds > lot.cost) wins++; holds.push(i - lot.at);
      level = sellAt;
    } else if (!lots.length && b.h[i]! >= sellAt) {
      level = b.c[i]!;
    }
    const eq = cash + qty * b.c[i]!;
    exposedSum += (qty * b.c[i]!) / eq;
    peak = Math.max(peak, eq); maxDrawdown = Math.max(maxDrawdown, 1 - eq / peak);
  }
  const last = b.c[to - 1]!;
  const eq = cash + qty * last * (1 - fee); // liquidate what's left
  fees += qty * last * fee;
  return { ret: eq - 1, trades, wins, exposure: exposedSum / Math.max(1, to - from - 1), maxDrawdown, fees, holds };
}
