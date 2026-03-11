#!/usr/bin/env bash
# stress-monitor.sh: Quick health check for the running stress test
# Outputs key metrics for at-a-glance monitoring

WEB_DIR="/home/user/djinn/web"
LOG="$WEB_DIR/test-results/signal-stress.log"
RUNNER_LOG="$WEB_DIR/test-results/runner.log"
STATS_LOG="$WEB_DIR/test-results/stress-stats.jsonl"

echo "=== Stress Test Monitor ($(date -u +%H:%M:%S\ UTC)) ==="

# Process status
pw_count=$(ps aux | grep -c '[p]laywright' || echo 0)
chrome_count=$(ps aux | grep 'chrome-headless' | grep -v grep | wc -l)
runner_count=$(ps aux | grep 'stress-runner' | grep -v grep | wc -l)
echo "Processes: runner=$runner_count, playwright=$pw_count, chromium=$chrome_count"

# Current run signals
if [ -f "$LOG" ]; then
  signals=$(grep -c '\[OK\].*Signal created' "$LOG" 2>/dev/null || echo 0)
  failures=$(grep -c '\[WARN\].*FAILED' "$LOG" 2>/dev/null || echo 0)
  purchases=$(grep -c '\[OK\].*Purchase succeeded' "$LOG" 2>/dev/null || echo 0)
  last_line=$(tail -1 "$LOG" 2>/dev/null | head -c 120)
  log_age=$(( $(date +%s) - $(stat -c %Y "$LOG") ))
  echo "Current run: signals=$signals, failures=$failures, purchases=$purchases (log age: ${log_age}s)"
  echo "Last: $last_line"
else
  echo "No active log file"
fi

# Cumulative stats
if [ -f "$STATS_LOG" ]; then
  last_stats=$(tail -1 "$STATS_LOG" 2>/dev/null)
  echo "Cumulative: $last_stats"
fi

# Wallet balances
deployer=$(cast balance 0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37 --rpc-url https://sepolia.base.org --ether 2>/dev/null || echo "?")
genius=$(cast balance 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d --rpc-url https://sepolia.base.org --ether 2>/dev/null || echo "?")
echo "Wallets: deployer=${deployer} ETH, genius=${genius} ETH"

# Stale check
if [ -f "$LOG" ] && [ "$log_age" -gt 300 ]; then
  echo "WARNING: Log hasn't been written in ${log_age}s, test may be stuck/dead"
fi
