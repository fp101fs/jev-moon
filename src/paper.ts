import type { Action, Fill, Position, SymbolName } from "./types";

export function gateAction(action: Action, confidence: number, stale: boolean): Action {
  return stale || confidence < 0.55 ? "HOLD" : action;
}

export function notionalForConfidence(confidence: number): number {
  if (confidence < 0.55) return 0;
  if (confidence < 0.7) return 100;
  if (confidence < 0.85) return 250;
  return 500;
}

export class PaperEngine {
  cash: number;
  fills: Fill[] = [];
  positions: Record<SymbolName, Position>;

  constructor(startingCash: number, private maxPositionUsd: number, private feeBps: number, private slippageBps: number) {
    this.cash = startingCash;
    this.positions = {
      "BTC/USD": { quantity: 0, averageEntry: 0, realizedPnl: 0 },
      "ETH/USD": { quantity: 0, averageEntry: 0, realizedPnl: 0 },
      "SOL/USD": { quantity: 0, averageEntry: 0, realizedPnl: 0 },
    };
  }

  execute(symbol: SymbolName, action: Action, confidence: number, bid: number, ask: number, timestamp = Date.now()): Fill | null {
    if (action === "HOLD") return null;
    const requested = notionalForConfidence(confidence);
    if (!requested) return null;
    const position = this.positions[symbol];
    const mid = (bid + ask) / 2;
    const direction = action === "BUY" ? 1 : -1;
    const currentExposure = position.quantity * mid;
    const remaining = Math.max(0, this.maxPositionUsd - direction * currentExposure);
    const notional = Math.min(requested, remaining);
    if (notional < 1) return null;
    const price = (action === "BUY" ? ask : bid) * (1 + direction * this.slippageBps / 10_000);
    const deltaQty = direction * notional / price;
    const fee = notional * this.feeBps / 10_000;
    this.applyTrade(position, deltaQty, price, fee);
    this.cash -= deltaQty * price + fee;
    const fill: Fill = { symbol, side: action, quantity: Math.abs(deltaQty), price, notional, fee, timestamp };
    this.fills.push(fill);
    if (this.fills.length > 200) this.fills.shift();
    return fill;
  }

  private applyTrade(position: Position, deltaQty: number, price: number, fee: number): void {
    const oldQty = position.quantity;
    const sameDirection = oldQty === 0 || Math.sign(oldQty) === Math.sign(deltaQty);
    if (sameDirection) {
      const total = Math.abs(oldQty) + Math.abs(deltaQty);
      position.averageEntry = total ? (Math.abs(oldQty) * position.averageEntry + Math.abs(deltaQty) * price) / total : 0;
      position.quantity = oldQty + deltaQty;
    } else {
      const closed = Math.min(Math.abs(oldQty), Math.abs(deltaQty));
      position.realizedPnl += closed * (price - position.averageEntry) * Math.sign(oldQty);
      position.quantity = oldQty + deltaQty;
      if (Math.abs(position.quantity) < 1e-12) {
        position.quantity = 0;
        position.averageEntry = 0;
      } else if (Math.sign(position.quantity) !== Math.sign(oldQty)) {
        position.averageEntry = price;
      }
    }
    position.realizedPnl -= fee;
  }

  summary(symbol: SymbolName, mid: number) {
    const p = this.positions[symbol];
    const unrealizedPnl = p.quantity * (mid - p.averageEntry);
    return { ...p, positionUsd: p.quantity * mid, unrealizedPnl, cash: this.cash };
  }

  equity(mids: Partial<Record<SymbolName, number>>): number {
    return this.cash + Object.entries(this.positions).reduce((sum, [symbol, p]) => sum + p.quantity * (mids[symbol as SymbolName] ?? p.averageEntry), 0);
  }
}
