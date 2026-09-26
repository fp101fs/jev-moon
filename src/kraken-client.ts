import { createHash, createHmac } from "crypto";

export interface KrakenOrderResult {
  txid: string[];
  descr: { order: string };
}

export interface PlaceOrderParams {
  pair: string;            // e.g. "XBTUSD", "ETHUSD", "SOLUSD"
  type: "buy" | "sell";
  ordertype: "limit" | "market";
  volume: number;
  price?: number;
  postOnly?: boolean;      // maker order
  validate?: boolean;      // dry-run flag
}

export class KrakenClient {
  private key: string;
  private secret: string;

  constructor(key?: string, secret?: string) {
    this.key = key || process.env.KRAKEN_API_KEY || "";
    this.secret = secret || process.env.KRAKEN_API_SECRET || "";
    if (!this.key || !this.secret) {
      throw new Error("KrakenClient: Missing KRAKEN_API_KEY or KRAKEN_API_SECRET");
    }
  }

  private getSignature(path: string, requestData: Record<string, any>): string {
    const postData = new URLSearchParams(requestData).toString();
    const sha256 = createHash("sha256").update(requestData.nonce + postData).digest();
    const hmac = createHmac("sha512", Buffer.from(this.secret, "base64"));
    hmac.update(path);
    hmac.update(sha256);
    return hmac.digest("base64");
  }

  async privateRequest<T = any>(path: string, params: Record<string, any> = {}): Promise<T> {
    const nonce = Date.now().toString() + "000";
    const body = { nonce, ...params };
    const signature = this.getSignature(path, body);

    const res = await fetch(`https://api.kraken.com${path}`, {
      method: "POST",
      headers: {
        "API-Key": this.key,
        "API-Sign": signature,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });

    const data = await res.json() as any;
    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API Error (${path}): ${data.error.join(", ")}`);
    }
    return data.result as T;
  }

  // Format volume precision based on pair
  formatVolume(pair: string, volume: number): string {
    if (pair.includes("SOL")) return volume.toFixed(4); // 4 decimals for SOL
    if (pair.includes("ETH")) return volume.toFixed(5); // 5 decimals for ETH
    if (pair.includes("XBT") || pair.includes("BTC")) return volume.toFixed(6); // 6 decimals for BTC
    return volume.toFixed(4);
  }

  // Format price precision based on pair
  formatPrice(pair: string, price: number): string {
    if (pair.includes("XBT") || pair.includes("BTC")) return price.toFixed(1);
    return price.toFixed(2);
  }

  async placeOrder(params: PlaceOrderParams): Promise<KrakenOrderResult> {
    const volumeStr = this.formatVolume(params.pair, params.volume);
    const body: Record<string, any> = {
      pair: params.pair,
      type: params.type,
      ordertype: params.ordertype,
      volume: volumeStr,
    };

    if (params.price) {
      body.price = this.formatPrice(params.pair, params.price);
    }
    if (params.postOnly) {
      body.oflags = "post";
    }
    if (params.validate) {
      body.validate = "true";
    }

    return this.privateRequest<KrakenOrderResult>("/0/private/AddOrder", body);
  }

  async cancelOrder(txid: string): Promise<{ count: number }> {
    return this.privateRequest<{ count: number }>("/0/private/CancelOrder", { txid });
  }

  async getOpenOrders(): Promise<Record<string, any>> {
    const res = await this.privateRequest<{ open: Record<string, any> }>("/0/private/OpenOrders");
    return res.open || {};
  }

  async getBalance(): Promise<Record<string, number>> {
    const raw = await this.privateRequest<Record<string, string>>("/0/private/Balance");
    const parsed: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const num = Number(v);
      if (num > 0) parsed[k] = num;
    }
    return parsed;
  }

  async getBestBidAsk(pair: string): Promise<{ bid: number; ask: number }> {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    const data = await res.json() as any;
    if (data.error && data.error.length > 0) throw new Error(data.error.join(", "));
    const keys = Object.keys(data.result);
    if (!keys.length) throw new Error(`No ticker data for ${pair}`);
    const t = data.result[keys[0]];
    return {
      bid: Number(t.b[0]),
      ask: Number(t.a[0]),
    };
  }
}
