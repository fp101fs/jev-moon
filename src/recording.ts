import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RecordingFrame {
  version: 1;
  offsetMs: number;
  capturedAt: string;
  snapshot: Record<string, any>;
}

export function startRecording(path: string): (snapshot: Record<string, any>) => void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { mode: 0o600 });
  const startedAt = Date.now();
  return (snapshot) => {
    const safeSnapshot = structuredClone(snapshot);
    const frame: RecordingFrame = {
      version: 1,
      offsetMs: Date.now() - startedAt,
      capturedAt: new Date().toISOString(),
      snapshot: safeSnapshot,
    };
    appendFileSync(path, `${JSON.stringify(frame)}\n`, { encoding: "utf8", mode: 0o600 });
  };
}

export const metaPathFor = (path: string) => path.replace(/\.jsonl$/, "") + ".meta.json";

export function writeRecordingMeta(path: string, meta: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(metaPathFor(path), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

export function readRecording(path: string): RecordingFrame[] {
  const text = readFileSync(path, "utf8");
  const frames = text.split("\n").filter(Boolean).map((line, index) => {
    const frame = JSON.parse(line) as RecordingFrame;
    if (frame.version !== 1 || !Number.isFinite(frame.offsetMs) || !frame.snapshot || typeof frame.snapshot !== "object") {
      throw new Error(`Invalid recording frame ${index + 1}`);
    }
    return frame;
  });
  if (!frames.length) throw new Error("Recording is empty");
  return frames.sort((a, b) => a.offsetMs - b.offsetMs);
}
