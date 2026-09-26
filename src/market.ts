import { SYMBOLS, type MarketState, type SymbolName } from "./types";
import { trimRollingState, updateLevel } from "./features";

const WS_URL = "wss://ws.kraken.com/v2";
const BOOK_DEPTH = 10;

/** Kraken sends no delete for levels that fall past the subscribed depth, so the client must drop them itself. */
export function truncateBook(market: Pick<MarketState, "bids" | "asks">, depth = BOOK_DEPTH): void {
  market.bids = new Map([...market.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, depth));
  market.asks = new Map([...market.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, depth));
}

export class KrakenMarketFeed {
  markets = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, { symbol, bids: new Map<number, number>(), asks: new Map<number, number>(), prices: [], trades: [], updatedAt: 0 }])) as unknown as Record<SymbolName, MarketState>;
  connected = false;
  resyncs = 0;
  eventTimes: number[] = [];
  private ws?: WebSocket;
  private retry = 500;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private onUpdate: () => void) {}

  start(): void { this.connect(); }
  stop(): void { if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.ws?.close(); }

  eventsPerSecond(now = Date.now()): number {
    this.eventTimes = this.eventTimes.filter((t) => t >= now - 1_000);
    return this.eventTimes.length;
  }

  private connect(): void {
    this.ws = new WebSocket(WS_URL);
    this.ws.addEventListener("open", () => {
      this.connected = true;
      this.retry = 500;
      this.ws!.send(JSON.stringify({ method: "subscribe", params: { channel: "book", symbol: SYMBOLS, depth: BOOK_DEPTH, snapshot: true } }));
      this.ws!.send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: SYMBOLS, snapshot: false } }));
      this.onUpdate();
    });
    this.ws.addEventListener("message", (event) => this.handle(JSON.parse(String(event.data))));
    this.ws.addEventListener("error", () => this.ws?.close());
    this.ws.addEventListener("close", () => {
      this.connected = false;
      this.onUpdate();
      this.reconnectTimer = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    });
  }

  /** Drop the connection so the reconnect re-subscribes and rebuilds every book from a fresh snapshot. */
  private resync(reason: string): void {
    if (!this.connected) return;
    this.resyncs++;
    console.warn(`Kraken resync #${this.resyncs}: ${reason}`);
    this.connected = false;
    this.ws?.close();
  }

  private handle(message: any): void {
    const now = Date.now();
    if (message.channel === "book" && Array.isArray(message.data)) {
      for (const data of message.data) {
        const market = this.markets[data.symbol as SymbolName];
        if (!market) continue;
        if (message.type === "snapshot") { market.bids.clear(); market.asks.clear(); }
        for (const level of data.bids ?? []) updateLevel(market.bids, Number(level.price), Number(level.qty));
        for (const level of data.asks ?? []) updateLevel(market.asks, Number(level.price), Number(level.qty));
        truncateBook(market);
        const bestBid = Math.max(...market.bids.keys());
        const bestAsk = Math.min(...market.asks.keys());
        if (bestBid >= bestAsk) { this.resync(`${data.symbol} book crossed (${bestBid} ≥ ${bestAsk})`); return; }
        if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) market.prices.push({ timestamp: now, price: (bestBid + bestAsk) / 2 });
        market.updatedAt = now;
        trimRollingState(market, now);
      }
      this.eventTimes.push(now);
      this.onUpdate();
    }
    if (message.channel === "trade" && Array.isArray(message.data)) {
      for (const trade of message.data) {
        const market = this.markets[trade.symbol as SymbolName];
        if (!market) continue;
        const signedNotional = Number(trade.qty) * Number(trade.price) * (trade.side === "buy" ? 1 : -1);
        if (Number.isFinite(signedNotional)) market.trades.push({ timestamp: now, signedNotional });
        trimRollingState(market, now);
      }
      this.eventTimes.push(now);
    }
  }
}
