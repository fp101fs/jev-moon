import type { MarketFeatures, MarketState, PricePoint } from "./types";

function priceAgo(points: PricePoint[], now: number, agoMs: number, fallback: number): number {
  const target = now - agoMs;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.timestamp <= target) return points[i]!.price;
  }
  return points[0]?.price ?? fallback;
}

function logReturn(current: number, previous: number): number {
  return current > 0 && previous > 0 ? Math.log(current / previous) : 0;
}

export function computeFeatures(market: MarketState, now = Date.now()): MarketFeatures | null {
  const bids = [...market.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 5);
  const asks = [...market.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 5);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0]![0];
  const ask = asks[0]![0];
  if (!(bid > 0 && ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  const bidDepth = bids.reduce((sum, [, qty]) => sum + qty, 0);
  const askDepth = asks.reduce((sum, [, qty]) => sum + qty, 0);
  const totalDepth = bidDepth + askDepth;
  const recent = market.prices.filter((p) => p.timestamp >= now - 5_000);
  const returns = recent.slice(1).map((p, i) => logReturn(p.price, recent[i]!.price));
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const volatility5s = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(1, returns.length));
  const trades = market.trades.filter((t) => t.timestamp >= now - 2_000);
  const grossFlow = trades.reduce((sum, t) => sum + Math.abs(t.signedNotional), 0);
  const netFlow = trades.reduce((sum, t) => sum + t.signedNotional, 0);
  return {
    symbol: market.symbol,
    bid, ask, mid,
    spreadBps: ((ask - bid) / mid) * 10_000,
    bookImbalance: totalDepth ? (bidDepth - askDepth) / totalDepth : 0,
    return500ms: logReturn(mid, priceAgo(market.prices, now, 500, mid)),
    return1s: logReturn(mid, priceAgo(market.prices, now, 1_000, mid)),
    return5s: logReturn(mid, priceAgo(market.prices, now, 5_000, mid)),
    volatility5s,
    recentTradeFlow: grossFlow ? netFlow / grossFlow : 0,
    timestamp: market.updatedAt,
    stale: now - market.updatedAt > 3_000,
  };
}

export function updateLevel(book: Map<number, number>, price: number, qty: number): void {
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) return;
  if (qty === 0) book.delete(price);
  else book.set(price, qty);
}

export function trimRollingState(market: MarketState, now = Date.now()): void {
  market.prices = market.prices.filter((p) => p.timestamp >= now - 12_000).slice(-600);
  market.trades = market.trades.filter((t) => t.timestamp >= now - 5_000).slice(-500);
  const bids = [...market.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 25);
  const asks = [...market.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 25);
  market.bids = new Map(bids);
  market.asks = new Map(asks);
}
