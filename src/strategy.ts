// The trading strategy, shared by the backtest (src/daily.ts) and the bot (src/bot.ts) so both do exactly the same thing.
//
// Per coin: a 200-day regime decides whether we're allowed to hold the coin at all. While the regime is on, either
//   - "grid": capital is split into `units` slots; each `spacing` drop below the last fill buys a slot with a resting
//     limit order (maker fee), each `spacing` rise sells the newest slot; when fully in cash the grid re-centres upward, or
//   - "hold": the whole allocation is held.
// When the regime turns off, everything is sold at market (taker fee) and the coin sits in cash.
// Trailing stop (checked on daily closes): while the regime is on, a close `trailingStop` below the highest close since
// entry also sells out; the coin is bought back only when a close makes a new high above that peak.

export interface StrategyConfig {
  mode: "grid" | "hold";
  spacing: number;       // grid step, e.g. 0.04 = 4%
  units: number;         // grid slots
  regimeDays: number;    // EMA length in days
  regimeBand: number;    // hysteresis: on above EMA × (1 + band), off below EMA × (1 − band)
  trailingStop: number;  // fallback trailing stop, e.g. 0.10 = 10%
  assetTrailingStops?: Record<string, number>; // asset-specific trailing stops e.g. { BTC: 0.08, ETH: 0.10, SOL: 0.12 }
  parabolicTrim?: boolean;                     // take partial profits when hyper-extended above 200d EMA
  parabolicStretchThreshold?: number;          // e.g. 1.60 = 60% above 200d EMA
  parabolicTrimFraction?: number;              // e.g. 0.25 = trim 25% to cash
  bullCashYieldApr?: number;                   // e.g. 0.15 = 15% APR on cash during crypto bull basis environment
  bearCashYieldApr?: number;                   // e.g. 0.05 = 5% APR on cash during bear/neutral
  makerBps: number;
  takerBps: number;      // including slippage
  cashYieldApr?: number; // fallback APR on unallocated cash
  makerEntry?: boolean;  // whether entries/re-entries use maker limit orders
  bullLeverage?: number; // e.g. 1.25 = 1.25x leverage in confirmed macro bull
  marginApr?: number;    // e.g. 0.06 = 6% APR on margin debt
}

export const DEFAULT_CONFIG: StrategyConfig = {
  mode: "hold",
  spacing: 0.04,
  units: 10,
  regimeDays: 200,
  regimeBand: 0.05,
  trailingStop: 0.1,
  assetTrailingStops: { BTC: 0.08, ETH: 0.10, SOL: 0.12 },
  parabolicTrim: true,
  parabolicStretchThreshold: 1.60,
  parabolicTrimFraction: 0.25,
  bullCashYieldApr: 0.15,
  bearCashYieldApr: 0.05,
  cashYieldApr: 0.05,
  makerBps: 22,
  takerBps: 40,
  makerEntry: true,
  bullLeverage: 1.25,
  marginApr: 0.06,
};

export type StrategyPreset = "core" | "core-zero-risk" | "core-leveraged" | "core-baseline";

export const STRATEGY_PRESETS: Record<StrategyPreset, StrategyConfig> = {
  core: { ...DEFAULT_CONFIG },
  "core-leveraged": { ...DEFAULT_CONFIG },
  "core-zero-risk": {
    ...DEFAULT_CONFIG,
    bullLeverage: 1.0,
  },
  "core-baseline": {
    ...DEFAULT_CONFIG,
    assetTrailingStops: undefined,
    parabolicTrim: false,
    bullCashYieldApr: 0,
    bearCashYieldApr: 0,
    cashYieldApr: 0,
    makerEntry: false,
    bullLeverage: 1.0,
  },
};



export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface Fill { t: number; side: "BUY" | "SELL"; price: number; qty: number; fee: number; kind: "grid" | "regime-on" | "regime-off" | "trailing-stop" | "dip-buy" | "dip-sell" | "top-up"; cashAfter: number }

export interface CoinState {
  cash: number;
  lots: number[];        // grid: coin quantity per open slot; hold: one lot with the whole position
  level: number;         // grid reference price (last fill)
  active: boolean;       // was the regime on for the previous bar
  regimeOn: boolean;     // decided at the last daily close, applies until the next one
  peak: number;          // highest daily close since entry (trailing stop)
  stopped: boolean;      // trailing stop has fired; waiting for a close above stopPeak
  stopPeak: number;
  ema: number | null;
  lastDailyClose: number | null; // timestamp (ms) of the last daily candle fed in
  trimmedQty?: number;
  topUp?: number;        // capital added mid-position, bought into the open position on the next allowed bar
}

export const newCoinState = (cash: number): CoinState => ({
  cash,
  lots: [],
  level: 0,
  active: false,
  regimeOn: false,
  peak: 0,
  stopped: false,
  stopPeak: 0,
  ema: null,
  lastDailyClose: null,
  trimmedQty: 0,
});

export class CoinStrategy {
  constructor(readonly cfg: StrategyConfig, public state: CoinState, readonly symbol?: string) {}

  get quantity(): number { return this.state.lots.reduce((a, q) => a + q, 0); }
  equity(price: number): number { return this.state.cash + this.quantity * price; }

  /** Feed each completed daily candle once, in order. Updates the regime used from the next bar on. */
  onDailyClose(t: number, close: number, isMacroBull?: boolean): void {
    const s = this.state;
    if (s.lastDailyClose !== null && t <= s.lastDailyClose) return;
    const a = 2 / (this.cfg.regimeDays + 1);
    s.ema = s.ema === null ? close : a * close + (1 - a) * s.ema;
    if (!s.regimeOn && close > s.ema * (1 + this.cfg.regimeBand)) s.regimeOn = true;
    else if (s.regimeOn && close < s.ema * (1 - this.cfg.regimeBand)) s.regimeOn = false;

    const stopDistance = (this.symbol && this.cfg.assetTrailingStops?.[this.symbol]) ?? this.cfg.trailingStop;
    if (!s.regimeOn || !stopDistance) { s.peak = 0; s.stopped = false; s.stopPeak = 0; s.trimmedQty = 0; }
    else if (s.stopped) {
      if (close > s.stopPeak) { s.stopped = false; s.peak = close; s.stopPeak = 0; s.trimmedQty = 0; }
    } else {
      s.peak = Math.max(s.peak ?? 0, close);
      if (close < s.peak * (1 - stopDistance)) { s.stopped = true; s.stopPeak = s.peak; s.trimmedQty = 0; }
    }

    if (s.cash > 0) {
      let apr = this.cfg.cashYieldApr ?? 0;
      if (this.cfg.bullCashYieldApr !== undefined && this.cfg.bearCashYieldApr !== undefined) {
        apr = (isMacroBull ?? s.regimeOn) ? this.cfg.bullCashYieldApr : this.cfg.bearCashYieldApr;
      }
      if (apr > 0) {
        s.cash += s.cash * (apr / 365.25);
      }
    }
    s.lastDailyClose = t;
  }

  /** Add fresh capital. In hold mode it joins an open position on the next bar if the coin is allowed; otherwise it waits as cash for the next entry. */
  addCapital(amount: number): void {
    this.state.cash += amount;
    if (this.cfg.mode === "hold") this.state.topUp = (this.state.topUp ?? 0) + amount;
  }

  /** May we hold the coin right now? Regime on and trailing stop not triggered. */
  get allowed(): boolean { return this.state.regimeOn && !this.state.stopped; }

  /** Process one completed 1-minute bar. Returns the fills it caused. */
  onBar(bar: Bar): Fill[] {
    const s = this.state, cfg = this.cfg, fills: Fill[] = [];
    const maker = cfg.makerBps / 1e4, taker = cfg.takerBps / 1e4;
    if (!this.allowed) {
      if (s.lots.length) {
        const qty = this.quantity, gross = qty * bar.o, fee = gross * taker;
        s.cash += gross - fee; s.lots = [];
        fills.push({ t: bar.t, side: "SELL", price: bar.o, qty, fee, kind: s.regimeOn ? "trailing-stop" : "regime-off", cashAfter: s.cash });
      }
      s.active = false;
      s.trimmedQty = 0;
      s.topUp = 0; // pending top-up stays as cash and is invested with the next full entry
      return fills;
    }
    if (cfg.mode === "hold") {
      // Parabolic extension trim
      if (cfg.parabolicTrim && s.ema && s.lots.length && (!s.trimmedQty || s.trimmedQty === 0)) {
        const stretchThresh = cfg.parabolicStretchThreshold ?? 1.60;
        if (bar.c > s.ema * stretchThresh) {
          const trimFrac = cfg.parabolicTrimFraction ?? 0.25;
          const trimQty = this.quantity * trimFrac;
          const gross = trimQty * bar.o, fee = gross * maker;
          s.cash += gross - fee;
          s.lots = [this.quantity - trimQty];
          s.trimmedQty = trimQty;
          fills.push({ t: bar.t, side: "SELL", price: bar.o, qty: trimQty, fee, kind: "dip-sell", cashAfter: s.cash });
        }
      } else if (s.trimmedQty && s.trimmedQty > 0 && s.ema && bar.c < s.ema * 1.30 && s.cash > 10) {
        // Re-accumulate trimmed cash
        const buyAmt = s.cash * 0.5;
        const feeRate = cfg.makerEntry ? maker : taker;
        const fee = buyAmt * feeRate, qty = (buyAmt - fee) / bar.o;
        s.lots.push(qty);
        s.cash -= buyAmt;
        s.trimmedQty = 0;
        fills.push({ t: bar.t, side: "BUY", price: bar.o, qty, fee, kind: "dip-buy", cashAfter: s.cash });
      }

      if (s.topUp && s.lots.length) {
        const buyAmt = Math.min(s.topUp, s.cash);
        const feeRate = cfg.makerEntry ? maker : taker;
        const fee = buyAmt * feeRate, qty = (buyAmt - fee) / bar.o;
        s.lots = [this.quantity + qty];
        s.cash -= buyAmt;
        fills.push({ t: bar.t, side: "BUY", price: bar.o, qty, fee, kind: "top-up", cashAfter: s.cash });
      }
      s.topUp = 0;

      if (!s.lots.length) {
        const feeRate = cfg.makerEntry ? maker : taker;
        const fee = s.cash * feeRate, qty = (s.cash - fee) / bar.o;
        s.lots = [qty]; s.cash = 0;
        fills.push({ t: bar.t, side: "BUY", price: bar.o, qty, fee, kind: "regime-on", cashAfter: s.cash });
      }
      s.active = true;
      return fills;
    }
    if (!s.active) { s.level = bar.o; s.active = true; }
    const slot = (s.cash + this.quantity * bar.o) / cfg.units;
    const buyAt = s.level * (1 - cfg.spacing), sellAt = s.level * (1 + cfg.spacing);
    if (bar.l <= buyAt && s.lots.length < cfg.units && s.cash >= slot * 0.999) {
      const fee = slot * maker, qty = (slot - fee) / buyAt;
      s.lots.push(qty); s.cash -= slot; s.level = buyAt;
      fills.push({ t: bar.t, side: "BUY", price: buyAt, qty, fee, kind: "grid", cashAfter: s.cash });
    } else if (bar.h >= sellAt && s.lots.length) {
      const qty = s.lots.pop()!, gross = qty * sellAt, fee = gross * maker;
      s.cash += gross - fee; s.level = sellAt;
      fills.push({ t: bar.t, side: "SELL", price: sellAt, qty, fee, kind: "grid", cashAfter: s.cash });
    } else if (!s.lots.length && bar.h >= sellAt) {
      s.level = bar.c;
    }
    return fills;
  }
}

// ── Dip sleeve ────────────────────────────────────────────────────────────────────────────────────
// A separate pot of cash per coin. While the coin's regime is on (uptrend), a bar whose low is `drop` below the highest
// high of the previous `windowMin` minutes triggers a market buy at the next bar's open, paying `crashSlipBps` of extra
// slippage on top of the taker fee (fills during crashes are worse). The position is sold at market `holdMin` later.

export interface DipConfig { drop: number; windowMin: number; holdMin: number; takerBps: number; crashSlipBps: number }
export const DEFAULT_DIP: DipConfig = { drop: 0.05, windowMin: 60, holdMin: 1440, takerBps: 40, crashSlipBps: 50 };

export interface DipState {
  cash: number;
  qty: number;
  entryT: number;
  pending: boolean;             // triggered; buy at the next bar's open
  highs: [number, number][];    // monotonic deque of [t, high] covering the last windowMin minutes
}
export const newDipState = (cash: number): DipState => ({ cash, qty: 0, entryT: 0, pending: false, highs: [] });

export class DipSleeve {
  constructor(readonly cfg: DipConfig, public state: DipState) {}

  equity(price: number): number { return this.state.cash + this.state.qty * price; }

  onBar(bar: Bar, uptrend: boolean): Fill[] {
    const s = this.state, cfg = this.cfg, fills: Fill[] = [];
    const taker = cfg.takerBps / 1e4;
    if (s.pending) {
      const price = bar.o * (1 + cfg.crashSlipBps / 1e4), fee = s.cash * taker, qty = (s.cash - fee) / price;
      s.qty = qty; s.cash = 0; s.entryT = bar.t; s.pending = false;
      fills.push({ t: bar.t, side: "BUY", price, qty, fee, kind: "dip-buy", cashAfter: s.cash });
    } else if (s.qty && bar.t >= s.entryT + cfg.holdMin * 60_000) {
      const gross = s.qty * bar.o, fee = gross * taker;
      s.cash += gross - fee;
      fills.push({ t: bar.t, side: "SELL", price: bar.o, qty: s.qty, fee, kind: "dip-sell", cashAfter: s.cash });
      s.qty = 0;
    }
    const priorHigh = s.highs[0]?.[1];
    if (!s.qty && !s.pending && uptrend && s.cash > 0 && priorHigh && bar.l <= priorHigh * (1 - cfg.drop)) s.pending = true;
    while (s.highs.length && s.highs.at(-1)![1] <= bar.h) s.highs.pop();
    s.highs.push([bar.t, bar.h]);
    while (s.highs[0]![0] <= bar.t - cfg.windowMin * 60_000) s.highs.shift();
    return fills;
  }
}
