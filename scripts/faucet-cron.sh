#!/usr/bin/env bash
# Runs auto-faucet if wallet balances are low. Called by stress-runner or cron.
# Requires ~/.cdp/api_key.json or CDP_API_KEY_ID + CDP_API_KEY_SECRET env vars.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="/home/user/.venv/bin/python3"
FAUCET_SCRIPT="$SCRIPT_DIR/auto-faucet.py"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "No venv python at $VENV_PYTHON"
  exit 1
fi

# Check deployer balance
deployer_bal=$(cast balance 0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37 --rpc-url https://sepolia.base.org 2>/dev/null || echo "0")
genius_bal=$(cast balance 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d --rpc-url https://sepolia.base.org 2>/dev/null || echo "0")

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Deployer: $deployer_bal wei, Genius: $genius_bal wei"

# Use python for comparison since bc may not be installed
is_below() {
  python3 -c "print(1 if int('${1:-0}') < int('${2}') else 0)" 2>/dev/null
}

THRESHOLD=3000000000000000

# Faucet if deployer < 0.003 ETH
if [ "$(is_below "$deployer_bal" "$THRESHOLD")" = "1" ]; then
  echo "Deployer low ($deployer_bal wei < $THRESHOLD), claiming..."
  timeout 60 "$VENV_PYTHON" "$FAUCET_SCRIPT" 0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37 --target 0.01 2>&1
fi

# Faucet if genius < 0.003 ETH
if [ "$(is_below "$genius_bal" "$THRESHOLD")" = "1" ]; then
  echo "Genius low ($genius_bal wei < $THRESHOLD), claiming..."
  timeout 60 "$VENV_PYTHON" "$FAUCET_SCRIPT" 0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d --target 0.01 2>&1
fi
