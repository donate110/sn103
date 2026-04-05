#!/usr/bin/env bash
# execute-upgrade-v4.sh
# Executes the combined V4 upgrade (queue-based-audits + off-chain decoys)
# for all 5 UUPS proxies, then sends a Telegram notification.
#
# Prerequisites:
#   - .env in ~/djinn/contracts with DEPLOYER_KEY, BASE_RPC_URL
#   - ACCOUNT_IMPL_V4, ESCROW_IMPL_V4, AUDIT_IMPL_V4,
#     OUTCOME_VOTING_IMPL_V4, SIGNAL_IMPL_V4 set in .env
#   - TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set in environment
#
# Usage: bash scripts/execute-upgrade-v4.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")/contracts"
FORGE="$HOME/.foundry/bin/forge"

if [[ -f "$CONTRACTS_DIR/.env" ]]; then
    set -a
    source "$CONTRACTS_DIR/.env"
    set +a
fi

: "${DEPLOYER_KEY:?DEPLOYER_KEY not set}"
: "${BASE_RPC_URL:?BASE_RPC_URL not set}"
: "${ACCOUNT_IMPL_V4:?ACCOUNT_IMPL_V4 not set}"
: "${ESCROW_IMPL_V4:?ESCROW_IMPL_V4 not set}"
: "${AUDIT_IMPL_V4:?AUDIT_IMPL_V4 not set}"
: "${OUTCOME_VOTING_IMPL_V4:?OUTCOME_VOTING_IMPL_V4 not set}"
: "${SIGNAL_IMPL_V4:?SIGNAL_IMPL_V4 not set}"

send_telegram() {
    local message="$1"
    if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
        echo "[WARN] Telegram not configured, skipping notification"
        return 0
    fi
    curl -s -X POST \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${TELEGRAM_CHAT_ID}" \
        -d "parse_mode=Markdown" \
        -d "text=${message}" \
        > /dev/null 2>&1 || echo "[WARN] Telegram notification failed"
}

echo "=== Djinn Protocol: Execute Combined V4 Upgrade ==="
cd "$CONTRACTS_DIR"

FORGE_OUTPUT=""
FORGE_EXIT=0

FORGE_OUTPUT=$("$FORGE" script script/ExecuteUpgradeV4.s.sol \
    --rpc-url "$BASE_RPC_URL" \
    --broadcast \
    -vvv 2>&1) || FORGE_EXIT=$?

echo "$FORGE_OUTPUT"

if [[ $FORGE_EXIT -eq 0 ]]; then
    TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
    send_telegram "$(cat <<MSG
*Djinn Combined V4 Upgrade Executed*

All 5 proxies upgraded on Base Sepolia:
- Account: \`0x4546...440B\`
- Escrow: \`0xb43B...692a\`
- Audit: \`0xCa7e...a44E\`
- OutcomeVoting: \`0xAD53...43e5\`
- SignalCommitment: \`0x4712...09C0\`

Includes: queue-based audits + off-chain decoys (DEV-042)

Completed: ${TIMESTAMP}
MSG
)"
    echo "Upgrade executed successfully."
else
    ERROR_TAIL=$(echo "$FORGE_OUTPUT" | tail -10 | head -c 500)
    TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
    send_telegram "$(cat <<MSG
*Djinn V4 Upgrade FAILED*

Exit code ${FORGE_EXIT}.
\`\`\`
${ERROR_TAIL}
\`\`\`
Time: ${TIMESTAMP}
MSG
)"
    echo "ERROR: Upgrade failed (exit $FORGE_EXIT)"
    exit $FORGE_EXIT
fi
