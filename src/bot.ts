import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CoinStrategy, DEFAULT_CONFIG, STRATEGY_PRESETS, newCoinState, type Bar, type CoinState, type Fill, type StrategyConfig, type StrategyPreset } from "./strategy";
import { KrakenClient } from "./kraken-client";

// Trading bot: live Kraken 1-minute candles, dual-mode (Paper simulation or Live execution).
//
//   bun src/bot.ts                      Run in Paper simulation ($100 default capital)
//   LIVE_TRADING=true bun src/bot.ts    Run in LIVE TRADING mode on real Kraken Pro
//   bun src/bot.ts status               Print positions, P&L, and recent trades
//   LIVE_TRADING=true bun src/bot.ts status   Print live Kraken positions & balances

const LIVE_TRADING = Bun.env.LIVE_TRADING === "true";
const kraken = LIVE_TRADING ? new KrakenClient() : null;

const PAIRS = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" } as const;
type Coin = keyof typeof PAIRS;
const COINS = Object.keys(PAIRS) as Coin[];
const DIR = Bun.env.BOT_DIR ?? (LIVE_TRADING ? "data/bot-live" : "data/bot");
const STATE = `${DIR}/state.json`, TRADES = `${DIR}/trades.jsonl`, DAILY = `${DIR}/daily.jsonl`;
const DAY = 86_400_000, POLL_MS = 60_000;
const num = (name: string, fallback: number) => { const v = Number(Bun.env[name] ?? fallback); return Number.isFinite(v) ? v : fallback; };

const presetName = (Bun.env.BOT_STRATEGY ?? "core") as StrategyPreset;
const preset = STRATEGY_PRESETS[presetName] ?? DEFAULT_CONFIG;

const config: StrategyConfig = {
  ...preset,
  mode: Bun.env.BOT_MODE === "grid" ? "grid" : preset.mode,
  trailingStop: num("TRAILING_STOP", Bun.env.BOT_MODE === "grid" ? 0 : preset.trailingStop),
  spacing: num("GRID_SPACING", preset.spacing),
  units: num("GRID_UNITS", preset.units),
  makerBps: num("MAKER_BPS", preset.makerBps),
  takerBps: num("TAKER_BPS", preset.takerBps),
  cashYieldApr: num("CASH_YIELD_APR", preset.cashYieldApr ?? 0),
  makerEntry: Bun.env.MAKER_ENTRY ? Bun.env.MAKER_ENTRY === "true" : preset.makerEntry,
  bullLeverage: num("BULL_LEVERAGE", preset.bullLeverage ?? 1.0),
  marginApr: num("MARGIN_APR", preset.marginApr ?? 0.06),
};

interface BotState {
  version: 1;
  startedAt: string;
  capital: number;
  config: StrategyConfig;
  live: boolean;
  coins: Record<Coin, CoinState>;
  lastBar: Record<Coin, number>;      // ms timestamp of the last 1-minute bar processed
  lastPrice: Record<Coin, number>;
  dayStart: { day: number; equity: number };
}

async function ohlc(pair: string, interval: number, since?: number): Promise<Bar[]> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}${since ? `&since=${Math.floor(since / 1000)}` : ""}`;
  const body = await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json() as any;
  if (body.error?.length) throw new Error(`Kraken ${pair}: ${body.error.join(", ")}`);
  const key = Object.keys(body.result).find((k) => k !== "last")!;
  // The last row is the current, still-forming candle; only completed candles are returned.
  return (body.result[key] as any[][]).slice(0, -1).map((r) => ({ t: Number(r[0]) * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
}

const save = (s: BotState) => { writeFileSync(`${STATE}.tmp`, JSON.stringify(s, null, 2)); renameSync(`${STATE}.tmp`, STATE); };
const load = (): BotState | null => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null);
const equity = (s: BotState) => COINS.reduce((a, c) => a + new CoinStrategy(s.config, s.coins[c]).equity(s.lastPrice[c]), 0);
const describeCfg = (c: StrategyConfig) => {
  const base = `${c.mode === "grid" ? `grid ${c.spacing * 100}% × ${c.units} + regime` : "regime hold"}${c.trailingStop ? ` + ${c.trailingStop * 100}% trailing stop` : ""}`;
  const extras = [
    c.cashYieldApr ? `${(c.cashYieldApr * 100).toFixed(0)}% cash yield` : "",
    c.makerEntry ? "maker entry" : "",
    c.bullLeverage && c.bullLeverage > 1 ? `${c.bullLeverage}x bull leverage` : "",
  ].filter(Boolean);
  return extras.length ? `${base} (${extras.join(", ")})` : base;
};
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const log = (msg: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")}  ${msg}`);

async function init(): Promise<BotState> {
  const existing = load();
  if (existing) {
    if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
      throw new Error(`Saved state uses a different strategy config than the current settings.\nSaved:   ${JSON.stringify(existing.config)}\nCurrent: ${JSON.stringify(config)}\nMove ${STATE} aside to start fresh.`);
    }
    log(`Resuming ${existing.live ? "LIVE KRAKEN" : "paper"} account from ${existing.startedAt} · equity ${money(equity(existing))}`);
    // Raising BOT_CAPITAL on an existing account adds the difference, split evenly; the strategy invests it on the next bar.
    const target = num("BOT_CAPITAL", existing.capital);
    if (target > existing.capital) {
      const extra = target - existing.capital;
      for (const coin of COINS) new CoinStrategy(existing.config, existing.coins[coin], coin).addCapital(extra / COINS.length);
      existing.capital = target;
      existing.dayStart.equity += extra; // new money isn't profit
      save(existing);
      log(`Capital raised to ${money(target)} (+${money(extra)}, ${money(extra / COINS.length)} per coin)`);
    } else if (target < existing.capital) {
      log(`BOT_CAPITAL ${money(target)} is below the account's ${money(existing.capital)} — lowering capital isn't supported, ignoring`);
    }
    return existing;
  }
  const capital = num("BOT_CAPITAL", 100);
  const state: BotState = {
    version: 1, startedAt: new Date().toISOString(), capital, config, live: LIVE_TRADING,
    coins: {} as BotState["coins"], lastBar: {} as BotState["lastBar"], lastPrice: {} as BotState["lastPrice"], dayStart: { day: 0, equity: capital },
  };
  for (const coin of COINS) {
    const strat = new CoinStrategy(config, newCoinState(capital / COINS.length), coin, false);
    for (const d of await ohlc(PAIRS[coin], 1440)) strat.onDailyClose(d.t, d.c); // warm up the 200-day regime
    const minutes = await ohlc(PAIRS[coin], 1);
    state.coins[coin] = strat.state;
    state.lastBar[coin] = minutes.at(-1)!.t; // start trading from now, not from replayed history
    state.lastPrice[coin] = minutes.at(-1)!.c;
  }
  state.dayStart = { day: Math.floor(Date.now() / DAY), equity: capital };
  mkdirSync(DIR, { recursive: true });
  save(state);
  log(`New ${LIVE_TRADING ? "🔴 LIVE KRAKEN" : "📄 paper"} account · ${money(capital)} split across ${COINS.join("/")} · ${describeCfg(config)} · maker ${config.makerBps} / taker ${config.takerBps} bps`);
  return state;
}

async function cycle(state: BotState): Promise<void> {
  for (const coin of COINS) {
    const strat = new CoinStrategy(state.config, state.coins[coin], coin, false);
    const bars = (await ohlc(PAIRS[coin], 1, state.lastBar[coin])).filter((b) => b.t > state.lastBar[coin]);
    if (!bars.length) continue;
    if (bars[0]!.t - state.lastBar[coin] > 2 * 60_000) log(`${coin}: gap of ${Math.round((bars[0]!.t - state.lastBar[coin]) / 60_000)} min in 1-minute data (bot was down?)`);
    // Feed any daily candle that completed before a bar we're about to process, so the regime updates at the right moment.
    const lastDaily = strat.state.lastDailyClose ?? 0;
    const pendingDaily = bars.at(-1)!.t >= lastDaily + 2 * DAY ? (await ohlc(PAIRS[coin], 1440)).filter((d) => d.t > lastDaily) : [];
    for (const bar of bars) {
      let orderFailed = false;
      while (pendingDaily.length && pendingDaily[0]!.t + DAY <= bar.t) {
        const d = pendingDaily.shift()!, was = strat.state.regimeOn, wasStopped = strat.state.stopped;
        strat.onDailyClose(d.t, d.c);
        if (strat.state.regimeOn !== was) log(`${coin}: regime turned ${strat.state.regimeOn ? "ON — trading resumes" : "OFF — selling out and sitting in cash"} (close ${d.c}, 200d EMA ${strat.state.ema!.toFixed(2)})`);
        else if (strat.state.stopped && !wasStopped) log(`${coin}: trailing stop hit — close ${d.c} is ${(state.config.trailingStop * 100).toFixed(0)}%+ below peak ${strat.state.stopPeak}; selling, will re-enter above ${strat.state.stopPeak}`);
        else if (!strat.state.stopped && wasStopped) log(`${coin}: new high ${d.c} above ${strat.state.peak} — re-entering`);
      }
      // Snapshot the books so a rejected Kraken order can be undone and retried on the next bar at a fresh price.
      const before = structuredClone(strat.state);
      let placed = 0;
      for (const fill of strat.onBar(bar)) {
        let liveTxid: string | undefined;
        if (LIVE_TRADING && kraken) {
          try {
            const pair = PAIRS[coin];
            if (fill.side === "BUY") {
              let orderPrice = bar.c;
              if (config.makerEntry) {
                try {
                  const bb = await kraken.getBestBidAsk(pair);
                  orderPrice = bb.bid;
                } catch {}
              }
              try {
                const res = await kraken.placeOrder({
                  pair,
                  type: "buy",
                  ordertype: config.makerEntry ? "limit" : "market",
                  volume: fill.qty,
                  price: config.makerEntry ? orderPrice : undefined,
                  postOnly: config.makerEntry,
                });
                liveTxid = res.txid[0];
                log(`[LIVE KRAKEN] Placed BUY ${fill.qty.toFixed(6)} ${coin} @ $${orderPrice} (txid: ${liveTxid})`);
              } catch (postErr: any) {
                if (config.makerEntry && String(postErr).includes("Post only")) {
                  const res = await kraken.placeOrder({ pair, type: "buy", ordertype: "market", volume: fill.qty });
                  liveTxid = res.txid[0];
                  log(`[LIVE KRAKEN FALLBACK] Placed market BUY ${fill.qty.toFixed(6)} ${coin} (txid: ${liveTxid})`);
                } else throw postErr;
              }
            } else if (fill.side === "SELL") {
              const isTrim = fill.kind === "dip-sell";
              let orderPrice = bar.c;
              if (isTrim) {
                try {
                  const bb = await kraken.getBestBidAsk(pair);
                  orderPrice = bb.ask;
                } catch {}
              }
              try {
                const res = await kraken.placeOrder({
                  pair,
                  type: "sell",
                  ordertype: isTrim ? "limit" : "market",
                  volume: fill.qty,
                  price: isTrim ? orderPrice : undefined,
                  postOnly: isTrim,
                });
                liveTxid = res.txid[0];
                log(`[LIVE KRAKEN] Placed SELL ${fill.qty.toFixed(6)} ${coin} (kind: ${fill.kind}, txid: ${liveTxid})`);
              } catch (postErr: any) {
                if (isTrim && String(postErr).includes("Post only")) {
                  const res = await kraken.placeOrder({ pair, type: "sell", ordertype: "market", volume: fill.qty });
                  liveTxid = res.txid[0];
                  log(`[LIVE KRAKEN FALLBACK] Placed market SELL ${fill.qty.toFixed(6)} ${coin} (txid: ${liveTxid})`);
                } else throw postErr;
              }
            }
            placed++;
          } catch (err) {
            log(`[LIVE KRAKEN ERROR] ${coin} ${fill.side} failed: ${err instanceof Error ? err.message : err}`);
            orderFailed = true;
            break;
          }
        }
        record(coin, fill, liveTxid);
      }
      state.lastBar[coin] = bar.t;
      state.lastPrice[coin] = bar.c;
      if (orderFailed) {
        if (placed === 0) {
          strat.state = state.coins[coin] = before;
          log(`${coin}: order not filled — books unchanged, retrying next minute`);
        } else {
          // Only reachable if one bar produces several fills and a later one fails; the earlier order is real, so keep the books.
          log(`${coin}: WARNING — ${placed} order(s) placed but a later one failed this bar; books may not match Kraken, check manually`);
        }
        break;
      }
    }
  }
  const today = Math.floor(Date.now() / DAY), eq = equity(state);
  if (today > state.dayStart.day) {
    const pnl = eq - state.dayStart.equity;
    const summary = { day: new Date(state.dayStart.day * DAY).toISOString().slice(0, 10), startEquity: state.dayStart.equity, endEquity: eq, pnl, pct: pnl / state.dayStart.equity };
    appendFileSync(DAILY, `${JSON.stringify(summary)}\n`);
    log(`DAY ${summary.day}: ${pnl >= 0 ? "+" : ""}${money(pnl)} (${(summary.pct * 100).toFixed(2)}%) · equity ${money(eq)} · since start ${money(eq - state.capital)}`);
    state.dayStart = { day: today, equity: eq };
  }
  save(state);
}

function record(coin: Coin, f: Fill, liveTxid?: string): void {
  appendFileSync(TRADES, `${JSON.stringify({ coin, ...f, liveTxid, time: new Date(f.t).toISOString() })}\n`);
  log(`${coin} ${f.side.padEnd(4)} ${f.qty.toFixed(6)} @ ${f.price.toFixed(2)} (${f.kind}) fee ${money(f.fee)}${liveTxid ? ` [txid: ${liveTxid}]` : ""}`);
}

async function status(): Promise<void> {
  const s = load();
  if (!s) { console.log(`No account state found in ${DIR} — run \`bun src/bot.ts\` first.`); return; }
  const eq = equity(s);
  console.log(`\n${s.live ? "🔴 LIVE KRAKEN ACCOUNT" : "📄 PAPER ACCOUNT"} since ${s.startedAt.slice(0, 16).replace("T", " ")} UTC · ${describeCfg(s.config)}`);
  console.log(`Allocated Capital: ${money(s.capital)} · Strategy Equity: ${money(eq)} (${((eq / s.capital - 1) * 100).toFixed(2)}%) · today ${eq - s.dayStart.equity >= 0 ? "+" : ""}${money(eq - s.dayStart.equity)}\n`);

  if (s.live && kraken) {
    try {
      const b = await kraken.getBalance();
      console.log(`Kraken Account Balances: USD: ${money(b.ZUSD || 0)} | BTC: ${(b.XXBT || 0).toFixed(6)} | ETH: ${(b.XETH || 0).toFixed(5)} | SOL: ${(b.SOL || 0).toFixed(4)}\n`);
    } catch (e) {
      console.log(`(Could not fetch live Kraken balances: ${e instanceof Error ? e.message : e})\n`);
    }
  }

  console.log(`${"coin".padEnd(6)}${"price".padStart(11)}${"regime".padStart(9)}${"200d EMA".padStart(11)}${"slots".padStart(7)}${"coin value".padStart(12)}${"cash".padStart(11)}${"next buy".padStart(11)}${"next sell".padStart(11)}`);
  for (const coin of COINS) {
    const st = new CoinStrategy(s.config, s.coins[coin], coin), c = s.coins[coin], p = s.lastPrice[coin];
    const grid = s.config.mode === "grid" && c.regimeOn;
    console.log(`${coin.padEnd(6)}${p.toFixed(2).padStart(11)}${(c.regimeOn ? (c.stopped ? "STOPPED" : "ON") : "off").padStart(9)}${(c.ema ?? 0).toFixed(2).padStart(11)}${`${c.lots.length}/${s.config.mode === "grid" ? s.config.units : 1}`.padStart(7)}${money(st.quantity * p).padStart(12)}${money(c.cash).padStart(11)}${(grid && c.level ? (c.level * (1 - s.config.spacing)).toFixed(2) : "—").padStart(11)}${(grid && c.lots.length ? (c.level * (1 + s.config.spacing)).toFixed(2) : "—").padStart(11)}`);
  }
  if (s.config.trailingStop) for (const coin of COINS) {
    const c = s.coins[coin];
    const stopPct = s.config.assetTrailingStops?.[coin] ?? s.config.trailingStop;
    if (c.regimeOn && c.stopped) console.log(`  ${coin}: stopped out — re-enters on a daily close above ${c.stopPeak}`);
    else if (c.regimeOn && c.peak) console.log(`  ${coin}: peak close ${c.peak} — trailing stop (${(stopPct * 100).toFixed(0)}%) fires on a daily close below ${(c.peak * (1 - stopPct)).toFixed(2)}`);
  }
  const trades = existsSync(TRADES) ? readFileSync(TRADES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log(`\n${trades.length} trades so far${trades.length ? ", latest:" : "."}`);
  for (const t of trades.slice(-5)) console.log(`  ${t.time.slice(0, 16).replace("T", " ")}  ${t.coin} ${t.side} ${t.qty.toFixed(6)} @ ${t.price.toFixed(2)} (${t.kind})${t.liveTxid ? ` [txid: ${t.liveTxid}]` : ""}`);
  const days = existsSync(DAILY) ? readFileSync(DAILY, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  if (days.length) {
    console.log(`\nLast ${Math.min(7, days.length)} days:`);
    for (const d of days.slice(-7)) console.log(`  ${d.day}  ${d.pnl >= 0 ? "+" : ""}${money(d.pnl)}  (${(d.pct * 100).toFixed(2)}%)`);
  }
}

if (Bun.argv[2] === "status") await status();
else {
  const state = await init();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await cycle(state); } catch (e) { log(`error: ${e instanceof Error ? e.message : e} — will retry next minute`); } finally { busy = false; }
  };
  const stop = () => { save(state); log("Stopped · state saved"); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  await tick();
  setInterval(tick, POLL_MS);
  setInterval(() => log(`equity ${money(equity(state))} · since start ${money(equity(state) - state.capital)}`), 60 * 60_000);
}
