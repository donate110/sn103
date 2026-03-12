#!/usr/bin/env bash
# stress-runner.sh: Runs the signal stress test in a loop, auto-restarting on crash.
# Archives logs between runs. Monitors health and reports stats.

# Note: do NOT use set -e or set -u here. The runner must survive command failures
# (cast balance errors, faucet failures, etc.) without exiting the restart loop.
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$WEB_DIR/test-results"
ARCHIVE_DIR="$LOG_DIR/archive"
LIVE_LOG="$LOG_DIR/signal-stress.log"
STATS_LOG="$LOG_DIR/stress-stats.jsonl"
MAX_RESTARTS=50
RESTART_DELAY=30

mkdir -p "$ARCHIVE_DIR"

restart_count=0
total_signals=0
total_failures=0
total_purchases=0

log() {
  local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [RUNNER] $*"
  echo "$msg" >> "$LOG_DIR/runner.log"
  echo "$msg" >&2
}

archive_log() {
  if [ -f "$LIVE_LOG" ]; then
    local ts
    ts=$(date -u +%Y%m%d_%H%M%S)
    mkdir -p "$ARCHIVE_DIR" 2>/dev/null || true
    cp "$LIVE_LOG" "$ARCHIVE_DIR/stress-$ts.log" 2>/dev/null || true
    log "Archived log to archive/stress-$ts.log"

    # Extract stats from this run (grep -c returns 1 on no match, so capture safely)
    local signals failures purchases
    signals=$(grep -c '\[OK\].*Signal created' "$LIVE_LOG" 2>/dev/null) || signals=0
    failures=$(grep -c '\[WARN\].*FAILED' "$LIVE_LOG" 2>/dev/null) || failures=0
    purchases=$(grep -c '\[OK\].*Purchase succeeded' "$LIVE_LOG" 2>/dev/null) || purchases=0

    total_signals=$((total_signals + signals))
    total_failures=$((total_failures + failures))
    total_purchases=$((total_purchases + purchases))

    # Append stats
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"run\":$restart_count,\"signals\":$signals,\"failures\":$failures,\"purchases\":$purchases,\"total_signals\":$total_signals,\"total_failures\":$total_failures,\"total_purchases\":$total_purchases}" >> "$STATS_LOG"

    log "Run stats: signals=$signals failures=$failures purchases=$purchases"
    log "Cumulative: signals=$total_signals failures=$total_failures purchases=$total_purchases"

    # Analyze failure reasons
    log "Top failure reasons:"
    grep '\[WARN\].*FAILED' "$LIVE_LOG" 2>/dev/null | sed 's/.*FAILED - //' | sort | uniq -c | sort -rn | head -5 | while read -r line; do
      log "  $line"
    done
  fi
}

try_auto_faucet() {
  # Attempt CDP faucet via the faucet-cron script
  local faucet_cron="$WEB_DIR/../scripts/faucet-cron.sh"
  if [ -x "$faucet_cron" ]; then
    log "Running faucet check..."
    timeout 120 bash "$faucet_cron" 2>&1 | while read -r line; do
      log "  [faucet] $line"
    done
    return $?
  fi
  # Fallback: direct faucet call for a specific address
  local faucet_script="$WEB_DIR/../scripts/auto-faucet.py"
  local venv_python="$WEB_DIR/../.venv/bin/python3"
  if [ -f "$faucet_script" ] && [ -x "$venv_python" ]; then
    log "Attempting auto-faucet claim for $1..."
    timeout 60 "$venv_python" "$faucet_script" "$1" --target 0.005 2>&1 | while read -r line; do
      log "  [faucet] $line"
    done
    return $?
  fi
  return 1
}

is_below() {
  # Compare large integers without bc (which may not be installed)
  python3 -c "print(1 if int('${1:-0}') < int('${2}') else 0)" 2>/dev/null
}

wei_to_eth() {
  python3 -c "print(f'{int(\"${1:-0}\") / 1e18:.6f}')" 2>/dev/null || echo "unknown"
}

check_deployer_health() {
  local deployer_bal
  deployer_bal=$(cast balance 0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37 --rpc-url https://sepolia.base.org 2>/dev/null || echo "0")
  log "Deployer ETH: $(wei_to_eth "$deployer_bal")"

  local genius_bal
  genius_bal=$(cast balance 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d --rpc-url https://sepolia.base.org 2>/dev/null || echo "0")
  log "Genius G0 ETH: $(wei_to_eth "$genius_bal")"

  # Auto-faucet if either wallet is low (below 0.003 ETH)
  if [ "$deployer_bal" != "0" ] && [ "$(is_below "$deployer_bal" 3000000000000000)" = "1" ]; then
    try_auto_faucet || log "Auto-faucet not available"
  elif [ "$genius_bal" != "0" ] && [ "$(is_below "$genius_bal" 3000000000000000)" = "1" ]; then
    try_auto_faucet || log "Auto-faucet not available"
  fi
}

cleanup() {
  log "Runner shutting down (signal received)"
  archive_log
  # Kill any running playwright
  pkill -f 'signal-stress' 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM

cd "$WEB_DIR"

log "=== Stress runner starting ==="
log "Max restarts: $MAX_RESTARTS, restart delay: ${RESTART_DELAY}s"

while [ "$restart_count" -lt "$MAX_RESTARTS" ]; do
  restart_count=$((restart_count + 1))
  log ""
  log "========== RUN $restart_count / $MAX_RESTARTS =========="

  check_deployer_health

  # Clean up any orphaned chromium processes from previous run
  pkill -f 'chrome-headless-shell.*playwright' 2>/dev/null || true
  sleep 2

  log "Launching Playwright stress test..."
  npx playwright test --config=playwright.stress.config.ts > "$LIVE_LOG" 2>&1
  exit_code=$?

  log "Playwright exited with code $exit_code"
  archive_log

  if [ $exit_code -eq 0 ]; then
    log "Test completed successfully"
  else
    log "Test failed/crashed (exit $exit_code)"
  fi

  # Check if we should stop (e.g., genius wallet drained)
  genius_bal=$(cast balance 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d --rpc-url https://sepolia.base.org 2>/dev/null || echo "0")
  if [ "$genius_bal" != "0" ] && [ "$(is_below "$genius_bal" 50000000000000)" = "1" ]; then
    log "WARNING: Genius G0 ETH critically low ($genius_bal wei), stopping runner"
    break
  fi

  log "Waiting ${RESTART_DELAY}s before restart... (restart_count=$restart_count, max=$MAX_RESTARTS)"
  sleep "$RESTART_DELAY"
  log "Restarting..."
done

log "=== Stress runner complete: $restart_count runs, $total_signals signals, $total_purchases purchases ==="
