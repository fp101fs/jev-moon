import type { Action, JevDecision, MarketFeatures } from "./types";

const ACTIONS: Action[] = ["BUY", "SELL", "HOLD"];

function finite01(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function parseJevResponse(raw: unknown, ids: string[]): { decisions: Record<string, JevDecision>; inputTokens: number; outputTokens: number; resolvedModel: string; cost: number } {
  if (!raw || typeof raw !== "object") throw new Error("Malformed Jev response");
  const body = raw as Record<string, unknown>;
  if (!body.answers || typeof body.answers !== "object") throw new Error("Missing Jev answers");
  const answers = body.answers as Record<string, unknown>;
  const decisions: Record<string, JevDecision> = {};
  for (const id of ids) {
    const answer = answers[id] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== "choice" || !ACTIONS.includes(answer.choice as Action)) throw new Error(`Invalid choice for ${id}`);
    if (!answer.probabilities || typeof answer.probabilities !== "object") throw new Error(`Missing probabilities for ${id}`);
    const p = answer.probabilities as Record<string, unknown>;
    const probabilities = Object.fromEntries(ACTIONS.map((a) => [a, finite01(p[a], `${id}.${a} probability`)])) as Record<Action, number>;
    const sum = ACTIONS.reduce((total, a) => total + probabilities[a], 0);
    if (Math.abs(sum - 1) > 0.02) throw new Error(`Probabilities do not sum to one for ${id}`);
    decisions[id] = { action: answer.choice as Action, confidence: finite01(answer.confidence, `${id} confidence`), probabilities };
  }
  const usage = (body.usage && typeof body.usage === "object" ? body.usage : {}) as Record<string, unknown>;
  return {
    decisions,
    inputTokens: typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    resolvedModel: typeof body.model === "string" ? body.model : "",
    cost: typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : 0,
  };
}

/** Rule-based stand-in for Jev: short-term momentum plus book imbalance and trade flow. */
export function momentumDecision(f: Pick<MarketFeatures, "return1s" | "bookImbalance" | "recentTradeFlow">): JevDecision {
  const signal = f.return1s * 900 + f.bookImbalance * 0.6 + f.recentTradeFlow * 0.4;
  const action: Action = signal > 0.12 ? "BUY" : signal < -0.12 ? "SELL" : "HOLD";
  const strength = Math.min(0.94, 0.52 + Math.abs(signal) * 0.32);
  const chosen = action === "HOLD" ? Math.max(0.56, strength) : strength;
  const rest = (1 - chosen) / 2;
  return {
    action,
    confidence: Math.min(0.96, chosen),
    probabilities: { BUY: rest, SELL: rest, HOLD: rest, [action]: chosen } as Record<Action, number>,
  };
}

export type PromptVersion = "horizon-60s-v1" | "original";
export const PROMPT_VERSIONS: PromptVersion[] = ["horizon-60s-v1", "original"];

export function questionFor(symbol: string, version: PromptVersion = "horizon-60s-v1") {
  if (version === "original") return {
    type: "choice",
    instructions: `Select exactly one short-horizon paper-trading action for ${symbol}, using only state["${symbol}"]. Judge immediate order flow, momentum, spread, shallow-book imbalance, data freshness, and current paper inventory. This is a bounded simulation decision, not investment advice.`,
    criteria: {
      BUY: "Short-horizon order flow, momentum, spread, and book imbalance support taking or increasing a small long paper position.",
      SELL: "Short-horizon order flow, momentum, spread, and book imbalance support selling, reducing a long position, or taking a small short paper position.",
      HOLD: "Evidence is weak, conflicting, stale, or current inventory and risk make trading unattractive.",
    },
  };
  // Stateless on purpose: no paper inventory, so simulation settings can't leak into what Jev sees.
  return {
    type: "choice",
    instructions: `Select exactly one paper-trading action for ${symbol}, using only state["${symbol}"]. The horizon is the next 60 seconds. Round-trip trading cost is about 12 bps, so choose BUY or SELL only if you expect the mid price to move more than 12 bps in that direction within the next 60 seconds; otherwise choose HOLD. Judge order flow, momentum, spread, shallow-book imbalance, and data freshness. This is a bounded simulation decision, not investment advice.`,
    criteria: {
      BUY: "The mid price is expected to rise by more than 12 bps within the next 60 seconds.",
      SELL: "The mid price is expected to fall by more than 12 bps within the next 60 seconds.",
      HOLD: "The expected move within the next 60 seconds is under 12 bps, unclear, or the data is stale.",
    },
  };
}

/** Hash of the exact prompt templates and state fields sent for every symbol, so recordings can be matched to prompts. */
export function promptSpec(version: PromptVersion, symbols: readonly string[]) {
  const questions = Object.fromEntries(symbols.map((s) => [s.replace("/", "_"), questionFor(s, version)]));
  const stateFields = Object.keys(compactState({} as MarketFeatures, version === "original" ? { positionUsd: 0, unrealizedPnl: 0, cash: 0 } : null));
  const text = JSON.stringify({ questions, stateFields });
  return { version, questions, stateFields, hash: new Bun.CryptoHasher("sha256").update(text).digest("hex") };
}

function compactState(feature: MarketFeatures, portfolio: { positionUsd: number; unrealizedPnl: number; cash: number } | null) {
  const r = (n: number | undefined, digits = 6) => Number((n ?? 0).toFixed(digits));
  return {
    symbol: feature.symbol,
    bid: feature.bid,
    ask: feature.ask,
    mid: feature.mid,
    spreadBps: r(feature.spreadBps, 3),
    bookImbalance: r(feature.bookImbalance),
    return500ms: r(feature.return500ms),
    return1s: r(feature.return1s),
    return5s: r(feature.return5s),
    volatility5s: r(feature.volatility5s),
    recentTradeFlow: r(feature.recentTradeFlow),
    ...(portfolio ? {
      paperPositionUsd: r(portfolio.positionUsd, 2),
      unrealizedPnl: r(portfolio.unrealizedPnl, 2),
      cash: r(portfolio.cash, 2),
    } : {}),
    timestamp: feature.timestamp ? new Date(feature.timestamp).toISOString() : "",
  };
}

export class JevProvider {
  constructor(private apiKey: string, readonly model: string, private endpoint = "https://api.typesafe.ai/v1/systemone", readonly promptVersion: PromptVersion = "horizon-60s-v1") {}

  get available(): boolean { return this.model === "mock" || Boolean(this.apiKey); }

  async decide(features: MarketFeatures[], portfolio: (symbol: string, mid: number) => { positionUsd: number; unrealizedPnl: number; cash: number }) {
    if (this.model === "mock") return this.mock(features);
    if (!this.apiKey) throw new Error("TYPESAFE_API_KEY or OPENROUTER_API_KEY is not configured");
    const questions = Object.fromEntries(features.map((f) => [f.symbol.replace("/", "_"), questionFor(f.symbol, this.promptVersion)]));
    const state = Object.fromEntries(features.map((f) => [f.symbol, compactState(f, this.promptVersion === "original" ? portfolio(f.symbol, f.mid) : null)]));
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Jev API returned HTTP ${response.status}`);
    return parseJevResponse(await response.json(), Object.keys(questions));
  }

  private mock(features: MarketFeatures[]) {
    const decisions: Record<string, JevDecision> = {};
    for (const f of features) decisions[f.symbol.replace("/", "_")] = momentumDecision(f);
    return { decisions, inputTokens: 0, outputTokens: 0, resolvedModel: "mock", cost: 0 };
  }
}
