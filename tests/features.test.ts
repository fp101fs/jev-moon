import { describe, expect, test } from "bun:test";
import { computeFeatures } from "../src/features";
import type { MarketState } from "../src/types";

describe("feature computation", () => {
  test("computes top-of-book metrics, returns, flow and bounded imbalance", () => {
    const now = 10_000;
    const market: MarketState = { symbol:"BTC/USD", bids:new Map([[100,2],[99,1]]), asks:new Map([[101,1],[102,1]]), updatedAt:now, prices:[{timestamp:5_000,price:99},{timestamp:9_000,price:100},{timestamp:9_500,price:100.2}], trades:[{timestamp:9_500,signedNotional:100},{timestamp:9_700,signedNotional:-25}] };
    const f=computeFeatures(market,now)!;
    expect(f.bid).toBe(100); expect(f.ask).toBe(101); expect(f.mid).toBe(100.5);
    expect(f.bookImbalance).toBeCloseTo(0.2); expect(f.return1s).toBeGreaterThan(0); expect(f.recentTradeFlow).toBeCloseTo(0.6);
  });
});

import { truncateBook } from "../src/market";
describe("book depth", () => {
  test("keeps only the best levels on each side, so stale out-of-range levels can't cross the book", () => {
    const market = { bids: new Map([[99, 1], [98, 1], [97, 1]]), asks: new Map([[100, 1], [103, 1], [101, 1]]) };
    truncateBook(market, 2);
    expect([...market.bids.keys()]).toEqual([99, 98]);
    expect([...market.asks.keys()]).toEqual([100, 101]);
  });
});
