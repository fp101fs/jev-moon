export const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"] as const;
export type SymbolName = (typeof SYMBOLS)[number];
export type Action = "BUY" | "SELL" | "HOLD";

export interface Level { price: number; qty: number }
export interface PricePoint { timestamp: number; price: number }
export interface TradePoint { timestamp: number; signedNotional: number }

export interface MarketState {
  symbol: SymbolName;
  bids: Map<number, number>;
  asks: Map<number, number>;
  prices: PricePoint[];
  trades: TradePoint[];
  updatedAt: number;
}

export interface MarketFeatures {
  symbol: SymbolName;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number;
  return500ms: number;
  return1s: number;
  return5s: number;
  volatility5s: number;
  recentTradeFlow: number;
  timestamp: number;
  stale: boolean;
}

export interface JevDecision {
  action: Action;
  confidence: number;
  probabilities: Record<Action, number>;
}

export interface Position {
  quantity: number;
  averageEntry: number;
  realizedPnl: number;
}

export interface Fill {
  symbol: SymbolName;
  side: Exclude<Action, "HOLD">;
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  timestamp: number;
}
