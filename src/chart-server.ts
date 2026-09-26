import { existsSync, readFileSync, statSync } from "fs";
import { KrakenClient } from "./kraken-client";

const port = Number(Bun.env.PORT || 3333);

let kraken: KrakenClient | null = null;
try {
  if (process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET) {
    kraken = new KrakenClient();
  }
} catch {
  kraken = null;
}

// In-memory cache to prevent excessive Kraken API rate-limiting
let cacheTime = 0;
let cachedData: any = null;

// The bot rewrites its state file after every successful 1-minute cycle, so the
// file's mtime doubles as a heartbeat.
const BOT_STALE_MS = 3 * 60_000;
function getBotHeartbeat(statePath: string) {
  if (!existsSync(statePath)) return { online: false, lastHeartbeat: null, secondsAgo: null };
  const mtime = statSync(statePath).mtimeMs;
  const ageMs = Date.now() - mtime;
  return { online: ageMs < BOT_STALE_MS, lastHeartbeat: new Date(mtime).toISOString(), secondsAgo: Math.round(ageMs / 1000) };
}

async function getLiveStatus() {
  const now = Date.now();
  if (cachedData && now - cacheTime < 3500) {
    return cachedData;
  }

  const liveStatePath = "data/bot-live/state.json";
  const liveTradesPath = "data/bot-live/trades.jsonl";
  const paperStatePath = "data/bot/state.json";
  const paperTradesPath = "data/bot/trades.jsonl";

  const isLive = existsSync(liveStatePath);
  const statePath = isLive ? liveStatePath : paperStatePath;
  const tradesPath = isLive ? liveTradesPath : paperTradesPath;

  let state: any = null;
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {}
  }

  let rawTrades: any[] = [];
  if (existsSync(tradesPath)) {
    try {
      rawTrades = readFileSync(tradesPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {}
  }

  let krakenBalances: Record<string, number> = {};
  let krakenOpenOrders: Record<string, any> = {};
  let krakenOrderDetails: Record<string, any> = {};

  if (kraken) {
    try {
      krakenBalances = await kraken.getBalance();
    } catch (e) {
      console.error("ChartServer: Failed to fetch Kraken balances:", e);
    }

    try {
      krakenOpenOrders = await kraken.getOpenOrders();
    } catch (e) {
      console.error("ChartServer: Failed to fetch Kraken open orders:", e);
    }

    const txids = rawTrades.map((t) => t.liveTxid).filter(Boolean);
    if (txids.length > 0) {
      try {
        krakenOrderDetails = await kraken.privateRequest("/0/private/QueryOrders", {
          txid: txids.join(","),
        });
      } catch (e) {
        console.error("ChartServer: Failed to query Kraken order details:", e);
      }
    }
  }

  const enrichedTrades = rawTrades.map((t, idx) => {
    const txid = t.liveTxid;
    const kOrder = txid && krakenOrderDetails[txid] ? krakenOrderDetails[txid] : null;
    const isOpen = txid && krakenOpenOrders[txid];

    let orderStatus = "UNKNOWN";
    let filledPrice = t.price;
    let filledQty = t.qty;
    let feePaid = t.fee;
    let actualCost = t.qty * t.price;

    if (kOrder) {
      if (kOrder.status === "closed") {
        orderStatus = "FILLED";
        filledPrice = Number(kOrder.price) || t.price;
        filledQty = Number(kOrder.vol_exec) || t.qty;
        actualCost = Number(kOrder.cost) || actualCost;
        feePaid = Number(kOrder.fee) || t.fee;
      } else if (kOrder.status === "open") {
        orderStatus = "OPEN_LIMIT";
      } else if (kOrder.status === "canceled") {
        orderStatus = "CANCELLED";
      } else {
        orderStatus = kOrder.status?.toUpperCase() || "PENDING";
      }
    } else if (isOpen) {
      orderStatus = "OPEN_LIMIT";
    } else if (!t.liveTxid) {
      orderStatus = "PAPER_SIMULATED";
    }

    return {
      id: txid || `trade-${idx}`,
      time: t.time,
      coin: t.coin,
      side: t.side,
      kind: t.kind,
      price: filledPrice,
      qty: filledQty,
      grossUsd: actualCost,
      fee: feePaid,
      liveTxid: txid || null,
      orderStatus,
      orderDesc: kOrder?.descr?.order || `${t.side} ${filledQty} ${t.coin} @ ${filledPrice}`,
    };
  });

  const result = {
    timestamp: new Date().toISOString(),
    bot: getBotHeartbeat(statePath),
    isLive,
    connectedToKraken: !!kraken,
    state,
    trades: enrichedTrades.reverse(), // most recent first
    balances: {
      USD: krakenBalances.ZUSD || krakenBalances.USD || 0,
      BTC: krakenBalances.XXBT || krakenBalances.XBT || krakenBalances.BTC || 0,
      ETH: krakenBalances.XETH || krakenBalances.ETH || 0,
      SOL: krakenBalances.SOL || 0,
    },
    openOrdersCount: Object.keys(krakenOpenOrders).length,
  };

  cachedData = result;
  cacheTime = now;
  return result;
}

const server = Bun.serve({
  port,
  routes: {
    "/": Bun.file("public/chart.html"),
    "/chart": Bun.file("public/chart.html"),
    "/chart-data.json": Bun.file("public/chart-data.json"),
  },
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/trades" || url.pathname === "/api/live-status") {
      try {
        const data = await getLiveStatus();
        return new Response(JSON.stringify(data, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err.message || "Failed to load live status" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/api/health") {
      const statePath = existsSync("data/bot-live/state.json") ? "data/bot-live/state.json" : "data/bot/state.json";
      const bot = getBotHeartbeat(statePath);
      return new Response(JSON.stringify({ server: "ok", bot }, null, 2), {
        status: bot.online ? 200 : 503,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    }

    if (url.pathname === "/chart-data.json") {
      return new Response(Bun.file("public/chart-data.json"), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n📊 Interactive React Strategy Chart ready at: http://localhost:${server.port}\n`);
