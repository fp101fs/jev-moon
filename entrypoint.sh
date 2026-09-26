#!/bin/sh
set -e

# Ensure data directory exists
mkdir -p data/bot-live

echo "=================================================="
echo "🚀 Starting Jev Moon Crypto Trading Suite"
echo "🌐 Port: ${PORT:-3333}"
echo "=================================================="

# Start interactive web chart server in background
PORT=${PORT:-3333} bun src/chart-server.ts &
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

# Keep container alive and monitor both processes
wait -n "$CHART_PID" "$BOT_PID"
