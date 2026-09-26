#!/bin/bash
# bash (not sh/dash) is required for `wait -n`

# Ensure data directory exists (may be an empty Railway volume on first boot)
mkdir -p data/bot-live

# Seed the volume with the known positions so the bot never starts from zero
# and re-buys. Never overwrites existing state.
if [ ! -f data/bot-live/state.json ]; then
  echo "🌱 No bot state found — seeding data/bot-live from image"
  cp -n seed/bot-live/* data/bot-live/
fi

export PORT=${PORT:-3333}

echo "=================================================="
echo "🚀 Starting Jev Moon Crypto Trading Suite"
echo "🌐 Port: ${PORT}"
echo "=================================================="

# Start interactive web chart server in background
bun src/chart-server.ts &
CHART_PID=$!

# Start continuous live trading bot in background
LIVE_TRADING=true BOT_CAPITAL=100 BOT_STRATEGY=core-zero-risk bun src/bot.ts &
BOT_PID=$!

# Graceful shutdown handler
shutdown() {
  echo "Received shutdown signal. Stopping child processes..."
  kill -TERM "$CHART_PID" "$BOT_PID" 2>/dev/null || true
  wait "$CHART_PID" 2>/dev/null || true
  wait "$BOT_PID" 2>/dev/null || true
  echo "Clean shutdown complete."
  exit 0
}

trap shutdown SIGTERM SIGINT

# Block until either process exits, then exit non-zero so Railway's
# ON_FAILURE restart policy brings the whole container back up.
wait -n "$CHART_PID" "$BOT_PID"
STATUS=$?
echo "⚠️  A child process exited (status $STATUS). Shutting down container for restart."
kill -TERM "$CHART_PID" "$BOT_PID" 2>/dev/null || true
exit 1
