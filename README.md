<p align="center">
  <img src="assets/hero.svg" alt="Jev Market Reflex — fast typed AI decisions on live crypto markets" width="100%">
</p>

<p align="center">
  <strong>Fast typed AI decisions on live crypto markets using TypeSafe AI Jev.</strong>
</p>

<p align="center">
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-runtime-14151A?logo=bun&logoColor=white" alt="Bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6d7781.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/execution-paper%20only-d6a84b" alt="Paper trading only">
</p>

<p align="center">
  Jev Market Reflex connects live BTC/USD, ETH/USD, and SOL/USD market data to Jev,<br>
  turns compact market state into typed <code>BUY</code> / <code>SELL</code> / <code>HOLD</code> decisions,<br>
  and applies them to a simulated paper portfolio.
</p>

<p align="center"><strong>Real market data. Simulated execution. No real money.</strong></p>

<p align="center">
  <a href="assets/demo.mp4"><img src="assets/demo.gif" alt="16-second Jev Market Reflex demo" width="100%"></a>
</p>

<p align="center"><a href="assets/demo.mp4"><strong>Watch the full-quality 16-second demo ↗</strong></a></p>

> **Live market data → compact state → Jev → typed decision → deterministic paper execution.**

## Quick start

Run the recorded demo with no API key and no external services:

```bash
git clone https://github.com/zzsong1023/jev-market-reflex.git
cd jev-market-reflex
bun install
bun run replay
```

Open [http://localhost:3000/?mode=theater](http://localhost:3000/?mode=theater). The standard dashboard remains available at [http://localhost:3000](http://localhost:3000).

The replay uses a sanitized real capture and is visibly labeled **RECORDED LIVE RUN · PAPER TRADING**.

## Live Jev mode

```bash
cp .env.example .env
# Add your TYPESAFE_API_KEY to .env
bun run dev
```

Open [http://localhost:3000/?mode=theater](http://localhost:3000/?mode=theater). Kraken's public market feed needs no exchange account or trading credentials.

The TypeSafe API key stays in the Bun server process. It is never sent to browser code, written to recordings, or printed in logs.

## What the loop does

```text
Kraken public WebSocket
        ↓
Bounded market features
        ↓
TypeSafe AI Jev
BUY / SELL / HOLD + probabilities
        ↓
Risk gate + deterministic paper execution
        ↓
Live browser visualization over SSE
```

A single Bun process maintains shallow order books and recent trade flow, computes short-horizon features, sends three Choice questions in one Jev System One request, applies deterministic risk rules, and streams the result to the browser. All state stays in memory.

Jev returns typed choices, confidence, and probabilities. Ordinary code owns every execution and risk rule.

## Example local run

Measured on September 19, 2026 using `jev-latest` and the live Kraken feed:

| Jev calls | Typed decisions | Failures | Missed cycles | Mean latency | P95 latency |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 21 | 63 | 0 | 0 | 199 ms | 332 ms |

This is one observed local run, not a benchmark or latency guarantee. Results depend on network conditions, API conditions, and machine location.

## Paper execution and safety

- Confidence below `0.55` becomes `HOLD`.
- Position sizing is deterministic: `$100`, `$250`, or `$500` by confidence band.
- Absolute exposure is capped per symbol by `MAX_POSITION_USD`.
- BUY fills use the ask plus configured slippage; SELL fills use the bid minus slippage.
- Fees, long and short positions, realized P&L, unrealized P&L, and equity are simulated locally.
- Stale or disconnected market data pauses decisions and execution.
- There is no wallet, exchange credential, trading API, database, or authentication layer.

Displayed P&L is a simulation diagnostic, not evidence that Jev predicts markets successfully.

## Replay, recording, and video mode

`bun run replay` plays [`recordings/example.jsonl`](recordings/example.jsonl), a sanitized real Jev/Kraken capture containing HOLD, BUY, SELL, and paper-fill events. It preserves the recorded event timing and uses no network services.

```bash
# Optional playback speed
REPLAY_SPEED=1.5 bun run replay

# Capture a new bounded real session (20 seconds by default)
bun run record

# Optimize either view for a 1440×900 recording
VIDEO_MODE=true bun run replay
```

New captures are written under `recordings/` and ignored by Git. They contain market features, typed decisions, probabilities, measured latency, fills, and timestamps—never keys or request headers.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `TYPESAFE_API_KEY` | — | Required only for live Jev mode |
| `JEV_MODEL` | `jev-latest` | TypeSafe model name |
| `DECISION_INTERVAL_MS` | `500` | Target decision-cycle interval |
| `STARTING_CASH` | `10000` | Virtual starting cash |
| `MAX_POSITION_USD` | `2000` | Maximum absolute exposure per symbol |
| `PAPER_FEE_BPS` | `5` | Simulated execution fee |
| `PAPER_SLIPPAGE_BPS` | `1` | Simulated fill slippage |
| `VIDEO_MODE` | `false` | Recording-optimized layout |
| `REPLAY_SPEED` | `1` | Replay speed multiplier |

## Testing

```bash
bun test
bun run typecheck
```

The focused tests cover feature computation, strict Jev response parsing, confidence gating, fills, P&L accounting, exposure limits, and the committed replay.

## Project structure

```text
public/              Dashboard and theater-mode presentation
src/
  market.ts          Kraken public WebSocket and bounded books
  features.ts        Compact short-horizon market features
  jev.ts             System One adapter and strict response parsing
  paper.ts           Deterministic paper execution and accounting
  server.ts          Live/record mode, metrics, and SSE
  recording.ts       Inspectable JSONL recording format
  replay.ts          Zero-network replay server
tests/               Focused Bun tests
recordings/          Committed sanitized demo capture
assets/              Demo video and README preview
docs/                Architecture notes
```

See [the architecture notes](docs/architecture.md) for system boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Disclaimer

**This is an AI systems demo, not a production trading system or a claim of profitable trading. Real market data. Simulated execution. Not financial advice.**

## License

[MIT](LICENSE)

## Is Jev better than a coin flip?

```bash
OPENROUTER_API_KEY=... RECORD_DURATION_SECONDS=7200 bun run record   # ~2h live session, ~$0.25 of Jev calls
bun run backtest recordings/live-<stamp>.jsonl
```

`backtest` scores Jev's direction at 5s/30s/60s (`HORIZONS_S`), counting only non-overlapping calls so z-scores aren't
inflated, plus "jev lean" (which side Jev puts more probability on, even when it holds) and a confidence-calibration table.
It then replays paper P&L against momentum, buy & hold, and a random baseline that trades at Jev's exact timing and size but
flips a coin for direction, at 5 and 26 bps fees (`FEE_SCENARIOS_BPS`).

Prompts: the default `JEV_PROMPT=horizon-60s-v1` states a 60s horizon and a 12 bps round-trip cost, and sends market data only
(no paper inventory, so simulation settings can't influence Jev). `JEV_PROMPT=original` is the author's prompt. Each recording
writes `<name>.meta.json` with the exact prompt, its hash, the interval, and every Jev version that answered.

## Paper-trading bot

```bash
bun run bot          # runs forever, polling Kraken 1-minute candles; state in data/bot/ survives restarts
bun run bot:status   # equity, today's P&L, positions, regime, next grid levels, recent trades and days
```

Strategy (`src/strategy.ts`, shared with the backtests): per coin, a 200-day EMA regime with a 5% buffer decides
whether the coin may be held, and a 10% trailing stop on daily closes sells after a 10% fall from the peak close
(re-entering on a new high). Backtest Jan 2022 – Aug 2026, $10,000, Kraken $10k-tier fees: +$12,503 (+125%, +19%/yr),
max drawdown −25%, worst month −9% (buy & hold: −2%, −77%). Neighbouring stop settings (8%, 12%) returned about +90%,
so expect something closer to that. `bun src/pnl-report.ts` reproduces these numbers through the bot's code.

Settings: `BOT_CAPITAL` (paper, default 10000), `BOT_STRATEGY` (`core`, `core-zero-risk`, or `core-leveraged`),
`TRAILING_STOP` (default 0.1; 0 = off), `BOT_MODE=grid` (4% × 10 grid inside regime: +34%, −10% drawdown),
`GRID_SPACING`, `GRID_UNITS`, `MAKER_BPS`, `TAKER_BPS`, `CASH_YIELD_APR` (default 0.05 on zero-risk/leveraged).
Paper only — it never places real orders.

## Core Strategy Offshoots & Comparative Performance

Run the head-to-head backtest across all 5.7 years of BTC/ETH/SOL data:
```bash
bun run compare
```

Three production configurations are built into `src/strategy.ts` and `src/bot.ts`:
1. **Core (Baseline)**: Original untouched benchmark: 200-day EMA trend filter + flat 10% trailing stop + patient new-high re-entry (`close > stopPeak`), taker fees, 0% cash yield.
2. **Core + Zero Extra Risk (`BOT_STRATEGY=core-zero-risk`)**: Fully unleveraged (1.0x). Integrates the 3 structural upgrades:
   - **Asset-Specific Stops**: 8% BTC (tighter exit at tops), 10% ETH, 12% SOL (room for high-beta pullbacks).
   - **Parabolic Extension Trimming**: Trims 25% of position into cash when price stretches > 60% above the 200d EMA.
   - **Dynamic Basis Yield**: 15% APR on idle cash during macro bull pauses (5% in bear).
   - **Maker-First Execution**: 22 bps limit orders vs 40 bps taker fees. Zero added leverage.
3. **New Core (`BOT_STRATEGY=core-leveraged` or `core`)**: Combines all Zero-Risk structural upgrades + **1.25x spot leverage** exclusively during synchronized macro bull runs (when BTC, ETH, and SOL all trend above their 200d averages).

### Head-to-Head Comparison ($10,000 Starting Capital, Kraken Pro Fees)

#### Conservative Window: Jan 2022 – Aug 2026 (4.7 Years, Starts into Crash)
| Strategy Variant | Ending Value | Total Profit ($) | Total Profit (%) | Ann. Return (CAGR) | Average $/Day | Max Drawdown | Worst Month | Trades |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Core Baseline (Orig)** | $20,905 | **+$10,905** | **+109%** | +17.1% | **$6.40 / day** | **−27.3%** | −11.6% | 83 |
| **Core + 0 Risk (Unlev)** | $25,401 | **+$15,401** | **+154%** | +22.1% | **$9.04 / day** | **−22.4% (Safer)** | −11.2% | 93 |
| **New Core (+1.25x Lev)** | $30,285 | **+$20,285** | **+203%** | +26.8% | **$11.90 / day** | **−25.3%** | −12.8% | 273 |

#### Full 5.1-Year Cycle: Aug 2021 – Aug 2026 (Includes 2021 Bull Run)
| Strategy Variant | Ending Value | Total Profit ($) | Total Profit (%) | Ann. Return (CAGR) | Average $/Day | Max Drawdown | Worst Month | Trades |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Core Baseline (Orig)** | $46,466 | **+$36,466** | **+365%** | +35.3% | **$19.64 / day** | **−36.1%** | −13.3% | 97 |
| **Core + 0 Risk (Unlev)** | $56,669 | **+$46,669** | **+467%** | +40.7% | **$25.13 / day** | **−29.4% (Safer)** | −12.4% | 109 |
| **New Core (+1.25x Lev)** | $101,625 | **+$91,625** | **+916%** | +57.8% | **$49.34 / day** | **−40.9%** | −16.8% | 306 |

### Year-by-Year Performance & Trade Activity (Fixed $10k Stake)

| Year | Market Phase | Buy & Hold Benchmark | Core + 0 Risk (Unlev) | New Core (+1.25x Lev) | Total Trades |
| :---: | :--- | :---: | :---: | :---: | :---: |
| **2021** *(Aug–Dec)* | Late Bull Supercycle | +159.0% (+$90.11/d) | +98.1% (+$64.11/d) | **+158.9% (+$103.82/d)** | 20–37 trades |
| **2022** | **Crypto Crash** | **−84.7% (−$20.68/d)** | **−15.0% (−$4.12/d)** | **−17.6% (−$4.81/d)** | **12–14 trades** |
| **2023** | Recovery Rally | +334.8% (+$105.47/d) | +87.5% (+$23.97/d) | **+129.0% (+$35.33/d)** | 22–70 trades |
| **2024** | Bull Expansion | +78.4% (+$22.70/d) | +57.0% (+$15.58/d) | **+62.8% (+$17.17/d)** | 39–123 trades |
| **2025** | Choppy Correction | −23.8% (−$4.88/d) | **+2.8% (+$0.76/d)** | **+1.3% (+$0.36/d)** | 31–79 trades |
| **2026** *(thru Aug)* | Sideways Drift | −16.7% (−$6.40/d) | **+9.4% (+$3.85/d)** | **+9.9% (+$4.05/d)** | 3–4 trades |

### Operating Cost & Overhead
- **Market Data Feed:** **$0.00 / day** (uses free public Kraken OHLC and WebSocket APIs; no keys required).
- **LLM / API Calls:** **$0.00 / day** (0 calls/day; the production Core bot operates on deterministic trend & stop logic, avoiding LLM price-prediction token costs).
- **Compute Overhead:** **$0.00 / day locally** (~45MB RAM Bun background process) or **~$0.13 / day (~$4/month)** on a basic cloud VPS (DigitalOcean / Hetzner) for 24/7 background execution.
- **Trade Turnover:** **~20 to 35 trades per year across the entire portfolio** (~1 to 3 trades per month total). No capital churn, zero micro-scalping fee burn.

## Dip Trading & Re-entry Research

- **Dip buying edge (`bun src/dips.ts`)**: Fast liquidations (e.g. 5% drops in 1h or 10% in 24h) in BTC/ETH/SOL exhibit statistically significant mean reversion (+1.0% to +5.9% net after fees over 24h), but **only while the 200-day regime is ON**. In downtrends, dips keep plummeting (−0.3% to −0.7% net loss).
- **Dip reserve sleeve (`bun run combined`)**: Holding 20–30% of capital in cash to buy dips reduces overall portfolio returns (+100% vs +125% core) because dip cash sits idle ~90% of the time, earning less than remaining fully invested in the trending core.
- **Dip re-entry after trailing stop (`bun run dip-reentry`)**:
  - *Permanent un-stop on dips*: Buying a 5% or 10% dip to un-stop the core position hurts performance (+66% to +97% vs +125% baseline at 50–100bps crash slip) and deepens drawdowns (−31% to −35% vs −25%) by catching falling knives during extended corrections.
  - *Temporary 24h dip trades with idle cash*: If the stopped cash is used strictly for a 24-hour mean-reversion trade (selling back to cash after 24h), it boosts P&L at low volume fees (+141% to +175% vs +125% at Kraken $10k+ fees, with drawdowns of −21% to −25%), but underperforms at retail/new-account fees (+65% to +74% vs +100%) due to fee drag over ~230 trades.
  - *Local high re-entry (10-day)*: Fails severely (+27% vs +125%) due to false breakouts during bear consolidations.
  - *Conclusion*: The default rule—holding 100% cash after a trailing stop until a confirmed new high (`close > stopPeak`)—remains the cleanest, lowest-turnover, and most robust core policy across all fee regimes.

Research scripts: `bun run candles` (single split), `bun run walkforward` (rolling out-of-sample), `bun run allocation`
(fractions, vol targeting, regime robustness), `bun run daily` (day-by-day experience of each candidate),
`bun src/regime-lab.ts` (regime variants: trailing stops, vol targets, golden cross), `bun src/dips.ts` (buy-the-dip study),
`bun run combined` (core + dip reserve sleeve), `bun run dip-reentry` (evaluating dip re-entry mechanics after trailing stops),
`bun run test-ideas` (universe expansion, leverage, cash yield tests), `bun run compare` (Core vs 0-Risk vs Leveraged offshoots).
Data: `data/klines/*-1m-hist.csv` from data.binance.vision (Jan 2021 – Aug 2026).


