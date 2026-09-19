import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readRecording } from "../src/recording";

describe("committed replay recording", () => {
  test("contains inspectable real decisions, fills, and normalized features", () => {
    const frames = readRecording("recordings/example.jsonl");
    const decisions = frames.flatMap((frame) => Object.values(frame.snapshot.markets).map((market: any) => market.decision));
    expect(frames.length).toBeGreaterThan(5);
    expect(decisions.some((d: any) => d.action === "BUY" && d.fill)).toBe(true);
    expect(decisions.some((d: any) => d.action === "SELL" && d.fill)).toBe(true);
    expect(decisions.some((d: any) => d.action === "HOLD")).toBe(true);
    expect(frames[0]!.snapshot.markets["BTC/USD"].bookImbalance).toBeNumber();
  });

  test("does not contain credentials or authorization headers", () => {
    const text = readFileSync("recordings/example.jsonl", "utf8");
    expect(text).not.toMatch(/Bearer|Authorization|TYPESAFE_API_KEY|api[_-]?key/i);
  });
});
