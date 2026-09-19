# Architecture

Jev Market Reflex is intentionally one small, long-running Bun process plus a static browser interface. There is no database, authentication layer, exchange account, or order-routing integration.

## Live path

```text
Kraken public WebSocket
  → bounded book and trade state
  → compact short-horizon features
  → one Jev request with three Choice questions
  → strict BUY / SELL / HOLD response validation
  → confidence, freshness, and exposure gates
  → deterministic paper fills
  → Server-Sent Events
  → dashboard or theater view
```

### Market state

`src/market.ts` subscribes to Kraken's public v2 book and trade channels for BTC/USD, ETH/USD, and SOL/USD. `src/features.ts` derives bid, ask, mid, spread, shallow-book imbalance, short returns, rolling volatility, trade flow, freshness, and event rate from bounded in-memory windows.

### Typed decisions

`src/jev.ts` is the small TypeSafe AI adapter. It sends compact state to the System One endpoint and asks one Choice question per market. The response parser accepts only `BUY`, `SELL`, or `HOLD`, finite confidence and probability values in `[0, 1]`, and probability totals close to one. Invalid responses become visible error events instead of crashing the process.

Only one Jev request may be in flight. A scheduled cycle is counted as missed when the previous call has not finished.

### Simulated execution

`src/paper.ts` owns the deterministic risk and accounting rules. Low-confidence or stale actions become `HOLD`; position size follows fixed confidence bands; exposure is capped per market; fees and slippage are simulated. No code path can submit an exchange order.

### Presentation

`src/server.ts` publishes snapshots over Server-Sent Events. The browser has two presentations backed by the same data:

- `/` is the detailed dashboard.
- `/?mode=theater` emphasizes the causal loop and is optimized for short recordings.

## Replay path

`src/replay.ts` serves the same frontend and SSE shape from `recordings/example.jsonl`. Replay does not connect to Kraken or TypeSafe AI and is always labeled as a recorded run. This makes the main demo reproducible without credentials or network services.

## Security boundary

`TYPESAFE_API_KEY` is read only by the Bun process. The browser receives market state, decisions, metrics, and simulated portfolio data—never environment variables, authorization headers, or request payload credentials. Recordings are sanitized and covered by a test that rejects common credential markers.
