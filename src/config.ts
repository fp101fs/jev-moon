function num(name: string, fallback: number): number {
  const value = Number(Bun.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const config = {
  port: num("PORT", 3000),
  apiKey: Bun.env.TYPESAFE_API_KEY ?? "",
  model: Bun.env.JEV_MODEL ?? "jev-latest",
  decisionIntervalMs: Math.max(250, num("DECISION_INTERVAL_MS", 500)),
  startingCash: num("STARTING_CASH", 10_000),
  maxPositionUsd: num("MAX_POSITION_USD", 2_000),
  feeBps: num("PAPER_FEE_BPS", 5),
  slippageBps: num("PAPER_SLIPPAGE_BPS", 1),
  staleAfterMs: 3_000,
  videoMode: Bun.env.VIDEO_MODE === "true",
};
