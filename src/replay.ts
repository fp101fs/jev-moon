import { readRecording } from "./recording";

const path = Bun.env.REPLAY_FILE ?? "recordings/example.jsonl";
const speed = Math.max(0.1, Number(Bun.env.REPLAY_SPEED ?? 1));
const port = Math.max(1, Number(Bun.env.PORT ?? 3000));
const frames = readRecording(path);
const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();
const replayStartedAt = Date.now();
let index = 0;
let loop = 0;
let current = prepare(frames[0]!.snapshot);

function prepare(source: Record<string, any>) {
  const snapshot = structuredClone(source);
  const finalTotal = frames.at(-1)?.snapshot?.metrics?.totalDecisions ?? 0;
  const finalCalls = frames.at(-1)?.snapshot?.metrics?.successfulCalls ?? 0;
  snapshot.now = Date.now();
  snapshot.startedAt = replayStartedAt;
  snapshot.status = { ...snapshot.status, mode: "replay", marketOnline: true, jevOnline: true, videoMode: Bun.env.VIDEO_MODE === "true" };
  snapshot.metrics.totalDecisions += loop * finalTotal;
  snapshot.metrics.successfulCalls += loop * finalCalls;
  return snapshot;
}

function send(snapshot = current): void {
  const payload = encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
  for (const client of clients) { try { client.enqueue(payload); } catch { clients.delete(client); } }
}

function scheduleNext(): void {
  const nextIndex = index + 1;
  if (nextIndex >= frames.length) {
    loop++;
    index = 0;
    current = prepare(frames[0]!.snapshot);
    send();
    setTimeout(scheduleNext, 700 / speed);
    return;
  }
  const delay = Math.max(60, (frames[nextIndex]!.offsetMs - frames[index]!.offsetMs) / speed);
  setTimeout(() => {
    index = nextIndex;
    current = prepare(frames[index]!.snapshot);
    send();
    scheduleNext();
  }, delay);
}

const server = Bun.serve({
  port,
  routes: {
    "/api/events": () => new Response(new ReadableStream({
      start(controller) { clients.add(controller); controller.enqueue(encoder.encode(`data: ${JSON.stringify(current)}\n\n`)); },
      cancel(controller) { clients.delete(controller); },
    }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } }),
    "/api/health": () => Response.json({ ok: true, mode: "replay", file: path, speed }),
    "/": Bun.file("public/index.html"),
    "/app.js": Bun.file("public/app.js"),
    "/styles.css": Bun.file("public/styles.css"),
  },
  fetch() { return new Response("Not found", { status: 404 }); },
});

scheduleNext();
console.log(`Jev Market Reflex replay: http://localhost:${server.port}`);
console.log(`Source: ${path} · ${frames.length} frames · ${speed}× speed · no network services`);
