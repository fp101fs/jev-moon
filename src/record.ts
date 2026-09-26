import { join } from "node:path";

if (!Bun.env.TYPESAFE_API_KEY && !Bun.env.OPENROUTER_API_KEY && Bun.env.JEV_MODEL !== "mock") {
  console.error("Cannot record: set TYPESAFE_API_KEY or OPENROUTER_API_KEY (or JEV_MODEL=mock).");
  process.exit(1);
}

const durationSeconds = Math.max(5, Number(Bun.env.RECORD_DURATION_SECONDS ?? 20));
const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const path = join("recordings", `live-${stamp}.jsonl`);
Bun.env.RECORDING_PATH = path;
Bun.env.RECORDING_DURATION_SECONDS = String(durationSeconds);

await import("./server");

setTimeout(() => {
  console.log(`Recording complete: ${path}`);
  process.exit(0);
}, durationSeconds * 1_000);
