#!/usr/bin/env bash
# Transfer ownership of all Djinn contracts to a multisig (e.g. Safe).
#
# Use this AFTER deployment to hand off control from the deployer key
# to a multisig wallet. Once transferred, only the multisig can:
#   - Change the protocol treasury address
#   - Authorize new contract callers
#   - Pause/unpause contracts
#   - Update protocol parameters
#
# Usage:
#   ./scripts/transfer-ownership.sh <new_owner_address>
#
# Example:
#   ./scripts/transfer-ownership.sh 0xYourSafeMultisigAddress

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/../contracts" && pwd)"
WEB_ENV="$(cd "$SCRIPT_DIR/../web" && pwd)/.env"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <new_owner_address>"
  echo ""
  echo "This transfers ownership of ALL Djinn contracts to the given address."
  echo "Use a multisig (Safe) for mainnet. This action is irreversible."
  exit 1
fi

NEW_OWNER="$1"

# Load deployer key
source "$CONTRACTS_DIR/.env"
RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

# Get contract addresses from web .env
get_addr() {
  grep "$1" "$WEB_ENV" | cut -d= -f2
}

SIGNAL_ADDR=$(get_addr "NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS")
ESCROW_ADDR=$(get_addr "NEXT_PUBLIC_ESCROW_ADDRESS")
COLLATERAL_ADDR=$(get_addr "NEXT_PUBLIC_COLLATERAL_ADDRESS")
CREDIT_ADDR=$(get_addr "NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS")
ACCOUNT_ADDR=$(get_addr "NEXT_PUBLIC_ACCOUNT_ADDRESS")
# Get Audit address from deploy log or hardcode
# It isn't in web/.env since the frontend doesn't call it directly
echo "=== Djinn Protocol — Ownership Transfer ==="
echo "New owner: $NEW_OWNER"
echo "RPC: $RPC_URL"
echo ""

# Verify current owner
CURRENT_OWNER=$(cast call "$SIGNAL_ADDR" "owner()(address)" --rpc-url "$RPC_URL")
echo "Current owner: $CURRENT_OWNER"
echo ""

echo "Transferring ownership of all contracts..."
echo "THIS IS IRREVERSIBLE. Press Ctrl+C within 5 seconds to cancel."
sleep 5

CONTRACTS=(
  "$SIGNAL_ADDR:SignalCommitment"
  "$ESCROW_ADDR:Escrow"
  "$COLLATERAL_ADDR:Collateral"
  "$CREDIT_ADDR:CreditLedger"
  "$ACCOUNT_ADDR:Account"
)

for entry in "${CONTRACTS[@]}"; do
  ADDR="${entry%%:*}"
  NAME="${entry##*:}"
  if [ -z "$ADDR" ]; then
    echo "  SKIP $NAME — address not found"
    continue
  fi
  echo "  Transferring $NAME ($ADDR)..."
  cast send "$ADDR" "transferOwnership(address)" "$NEW_OWNER" \
    --private-key "$DEPLOYER_KEY" \
    --rpc-url "$RPC_URL" \
    --quiet 2>&1 || echo "    FAILED — may already be transferred"
done

echo ""
echo "Done! Verify new owner:"
cast call "$SIGNAL_ADDR" "owner()(address)" --rpc-url "$RPC_URL"
echo ""
echo "NOTE: Audit contract also needs ownership transfer."
echo "If you have its address, run:"
echo "  cast send <AUDIT_ADDR> 'transferOwnership(address)' $NEW_OWNER --private-key \$DEPLOYER_KEY --rpc-url $RPC_URL"
