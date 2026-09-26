import { PROMPT_VERSIONS, type PromptVersion } from "./jev";

function num(name: string, fallback: number): number {
  const value = Number(Bun.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const config = {
  port: num("PORT", 3000),
  // A TypeSafe key calls TypeSafe directly; an OpenRouter key calls Jev through OpenRouter's decisions endpoint.
  apiKey: Bun.env.TYPESAFE_API_KEY || Bun.env.OPENROUTER_API_KEY || "",
  endpoint: Bun.env.JEV_ENDPOINT || (!Bun.env.TYPESAFE_API_KEY && Bun.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/alpha/decisions" : "https://api.typesafe.ai/v1/systemone"),
  model: Bun.env.JEV_MODEL || (!Bun.env.TYPESAFE_API_KEY && Bun.env.OPENROUTER_API_KEY ? "~typesafe/jev-latest" : "jev-latest"),
  promptVersion: (PROMPT_VERSIONS as string[]).includes(Bun.env.JEV_PROMPT ?? "") ? Bun.env.JEV_PROMPT as PromptVersion : "horizon-60s-v1",
  decisionIntervalMs: Math.max(250, num("DECISION_INTERVAL_MS", 750)),
  startingCash: num("STARTING_CASH", 10_000),
  maxPositionUsd: num("MAX_POSITION_USD", 2_000),
  feeBps: num("PAPER_FEE_BPS", 5),
  slippageBps: num("PAPER_SLIPPAGE_BPS", 1),
  staleAfterMs: 3_000,
  videoMode: Bun.env.VIDEO_MODE === "true",
};
