import { config } from "./config";
import { computeFeatures } from "./features";
import { JevProvider, promptSpec } from "./jev";
import { KrakenMarketFeed } from "./market";
import { gateAction } from "./paper";
import { PaperEngine } from "./paper";
import { SYMBOLS, type Action, type JevDecision, type SymbolName } from "./types";
import { startRecording, writeRecordingMeta } from "./recording";

const startedAt = Date.now();
const clients = new Set<ReadableStreamDefaultController>();
const paper = new PaperEngine(config.startingCash, config.maxPositionUsd, config.feeBps, config.slippageBps);
const jev = new JevProvider(config.apiKey, config.model, config.endpoint, config.promptVersion);
const prompt = promptSpec(config.promptVersion, SYMBOLS);
const decisions: any[] = [];
const decisionTimes: number[] = [];
const latencies: number[] = [];
let totalDecisions = 0;
let inFlight = false;
let successfulCalls = 0;
let failedCalls = 0;
let skippedCycles = 0;
let marketWaitCycles = 0;
let inputTokens = 0;
let apiCost = 0;
let resolvedModel = "";
let outputTokens = 0;
let lastError = "";
let jevOnline = jev.available;
let lastBroadcast = 0;
const recordSnapshot = Bun.env.RECORDING_PATH ? startRecording(Bun.env.RECORDING_PATH) : null;
const resolvedModels = new Set<string>();

// Everything needed to know exactly what Jev was asked. The paper-trading settings are listed for reference only:
// they are not sent to Jev, and the backtest re-simulates from raw decisions.
function writeMeta(): void {
  if (!Bun.env.RECORDING_PATH) return;
  writeRecordingMeta(Bun.env.RECORDING_PATH, {
    startedAt: new Date(startedAt).toISOString(),
    plannedDurationSeconds: Number(Bun.env.RECORDING_DURATION_SECONDS) || null,
    endpoint: config.endpoint,
    requestedModel: config.model,
    resolvedModels: [...resolvedModels],
    decisionIntervalMs: config.decisionIntervalMs,
    promptVersion: prompt.version,
    promptHash: prompt.hash,
    prompt: { questions: prompt.questions, stateFields: prompt.stateFields },
    symbols: SYMBOLS,
    liveSimulation: { startingCash: config.startingCash, maxPositionUsd: config.maxPositionUsd, feeBps: config.feeBps, slippageBps: config.slippageBps, confidenceGate: 0.55 },
  });
}
writeMeta();

const feed = new KrakenMarketFeed(() => {
  const now = Date.now();
  if (now - lastBroadcast > 80) { lastBroadcast = now; broadcast(); }
});

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

function snapshot() {
  const features = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, computeFeatures(feed.markets[symbol])]));
  const mids = Object.fromEntries(SYMBOLS.flatMap((symbol) => features[symbol] ? [[symbol, features[symbol]!.mid]] : []));
  const markets = Object.fromEntries(SYMBOLS.map((symbol) => {
    const feature = features[symbol];
    const latest = decisions.find((d) => d.symbol === symbol);
    const portfolio = paper.summary(symbol, feature?.mid ?? paper.positions[symbol].averageEntry);
    return [symbol, { ...feature, sparkline: feed.markets[symbol].prices.slice(-80), decision: latest ?? null, portfolio }];
  }));
  const totalRealized = Object.values(paper.positions).reduce((s, p) => s + p.realizedPnl, 0);
  return {
    type: "snapshot",
    now: Date.now(), startedAt,
    status: { mode: recordSnapshot ? "record" : "live", marketOnline: feed.connected && SYMBOLS.every((s) => !features[s]?.stale), jevOnline, model: config.model, resolvedModel, promptVersion: prompt.version, promptHash: prompt.hash, lastError, videoMode: config.videoMode },
    metrics: {
      totalDecisions,
      decisionsPerMinute: decisionTimes.filter((t) => t > Date.now() - 60_000).length,
      currentLatency: latencies.at(-1) ?? 0,
      averageLatency: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length),
      p50Latency: percentile(latencies, 0.5), p95Latency: percentile(latencies, 0.95),
      successfulCalls, failedCalls, skippedCycles, marketWaitCycles, marketResyncs: feed.resyncs, inputTokens, outputTokens, apiCost,
      marketEventsPerSecond: feed.eventsPerSecond(), fills: paper.fills.length,
      equity: paper.equity(mids), paperPnl: paper.equity(mids) - config.startingCash,
      realizedPnl: totalRealized,
    },
    markets,
    tape: decisions.slice(0, 50),
  };
}

function broadcast(): void {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  const encoded = new TextEncoder().encode(payload);
  for (const client of clients) { try { client.enqueue(encoded); } catch { clients.delete(client); } }
}

async function cycle(): Promise<void> {
  if (inFlight) { skippedCycles++; broadcast(); return; }
  const features = SYMBOLS.map((s) => computeFeatures(feed.markets[s])).filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (!feed.connected || features.length !== SYMBOLS.length || features.some((f) => f.stale)) { marketWaitCycles++; return; }
  if (!jev.available) { jevOnline = false; return; }
  inFlight = true;
  const started = performance.now();
  try {
    const result = await jev.decide(features, (symbol, mid) => paper.summary(symbol as SymbolName, mid));
    const latency = performance.now() - started;
    latencies.push(latency); if (latencies.length > 300) latencies.shift();
    successfulCalls++; jevOnline = true; lastError = "";
    inputTokens += result.inputTokens; outputTokens += result.outputTokens; apiCost += result.cost; resolvedModel = result.resolvedModel;
    if (resolvedModel && !resolvedModels.has(resolvedModel)) { resolvedModels.add(resolvedModel); writeMeta(); }
    const timestamp = Date.now();
    for (const feature of features) {
      const decision: JevDecision = result.decisions[feature.symbol.replace("/", "_")]!;
      const effectiveAction: Action = gateAction(decision.action, decision.confidence, feature.stale);
      const fill = paper.execute(feature.symbol, effectiveAction, decision.confidence, feature.bid, feature.ask, timestamp);
      decisions.unshift({ symbol: feature.symbol, rawAction: decision.action, action: effectiveAction, confidence: decision.confidence, probabilities: decision.probabilities, latency, price: feature.mid, timestamp, fill, model: result.resolvedModel });
      decisionTimes.push(timestamp);
      totalDecisions++;
    }
    if (decisions.length > 180) decisions.length = 180;
    while (decisionTimes.length && decisionTimes[0]! < timestamp - 60_000) decisionTimes.shift();
    recordSnapshot?.(snapshot());
  } catch (error) {
    failedCalls++; jevOnline = false;
    lastError = error instanceof Error ? error.message : "Unknown Jev error";
    decisions.unshift({ type: "error", timestamp: Date.now(), message: lastError });
    if (decisions.length > 180) decisions.length = 180;
  } finally {
    inFlight = false; broadcast();
  }
}

feed.start();
setInterval(cycle, config.decisionIntervalMs);
setInterval(broadcast, 1_000);

const server = Bun.serve({
  port: config.port,
  routes: {
    "/api/events": () => new Response(new ReadableStream({
      start(controller) { clients.add(controller); controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(snapshot())}\n\n`)); },
      cancel(controller) { clients.delete(controller); },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" } }),
    "/api/health": () => Response.json({ ok: true, marketConnected: feed.connected, jevConfigured: jev.available, model: config.model }),
    "/": Bun.file("public/index.html"),
    "/chart": Bun.file("public/chart.html"),
    "/chart-data.json": Bun.file("public/chart-data.json"),
    "/app.js": Bun.file("public/app.js"),
    "/styles.css": Bun.file("public/styles.css"),
  },
  fetch() { return new Response("Not found", { status: 404 }); },
});

console.log(`Jev Market Reflex: http://localhost:${server.port}`);
console.log(`${recordSnapshot ? `Recording to ${Bun.env.RECORDING_PATH} · ` : ""}${config.model === "mock" ? "MOCK MODEL" : jev.available ? `JEV READY · prompt ${prompt.version} (${prompt.hash.slice(0, 12)}) · every ${config.decisionIntervalMs}ms` : "JEV OFFLINE — add TYPESAFE_API_KEY or OPENROUTER_API_KEY"} · Kraken public feed`);
