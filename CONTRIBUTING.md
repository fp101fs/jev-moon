# Contributing

Thanks for helping improve Jev Market Reflex. Keep contributions focused on a fast, understandable paper-trading demo rather than production trading infrastructure.

## Local setup

```bash
bun install
bun run replay
```

Replay is the preferred first check because it is deterministic and needs no credentials. For live mode, copy `.env.example` to `.env`, add a TypeSafe API key, and run `bun run dev`.

## Before opening a pull request

```bash
bun test
bun run typecheck
```

Also verify both `/` and `/?mode=theater` at 1440×900. The three markets, decision activity, action log, and status labels should be visible without scrolling.

## Scope and safety

- Never add real-order execution, wallet handling, or exchange credentials.
- Never commit `.env`, API keys, request headers, or unsanitized recordings.
- Keep state in memory and architecture small.
- Preserve the visible replay label; recorded data must never look live.
- Do not describe simulated P&L as evidence of profitability.

Bug reports should include the run mode, Bun version, console output with secrets removed, and reproduction steps.
