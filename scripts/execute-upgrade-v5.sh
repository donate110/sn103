#!/usr/bin/env bash
# Executes the combined V5 upgrade (all fixes including protocol fee)
set -euo pipefail

CONTRACTS_DIR="$HOME/djinn/contracts"
FORGE="$HOME/.foundry/bin/forge"

if [[ -f "$CONTRACTS_DIR/.env" ]]; then
    set -a; source "$CONTRACTS_DIR/.env"; set +a
fi

: "${DEPLOYER_KEY:?DEPLOYER_KEY not set}"

# Map V5 env vars to what ExecuteUpgradeV4 expects
export ACCOUNT_IMPL_V4="${ACCOUNT_IMPL_V5:?ACCOUNT_IMPL_V5 not set}"
export ESCROW_IMPL_V4="${ESCROW_IMPL_V5:?ESCROW_IMPL_V5 not set}"
export AUDIT_IMPL_V4="${AUDIT_IMPL_V5:?AUDIT_IMPL_V5 not set}"
export OUTCOME_VOTING_IMPL_V4="${OUTCOME_VOTING_IMPL_V5:?OUTCOME_VOTING_IMPL_V5 not set}"
export SIGNAL_IMPL_V4="${SIGNAL_IMPL_V5:?SIGNAL_IMPL_V5 not set}"

cd "$CONTRACTS_DIR"

# We need an ExecuteUpgradeV5 script with the V5 salt
"$FORGE" script script/ExecuteUpgradeV5.s.sol \
    --rpc-url https://sepolia.base.org \
    --broadcast \
    -vvv 2>&1

echo "V5 upgrade executed."
