#!/usr/bin/env bash
# Deploy Djinn Protocol to Base Sepolia and update web/.env with new addresses.
#
# Prerequisites:
#   1. contracts/.env must exist with DEPLOYER_KEY set to a funded private key
#   2. The deployer wallet needs ~0.01 ETH on Base Sepolia for gas
#
# Usage:
#   ./scripts/deploy-base-sepolia.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
WEB_DIR="$ROOT_DIR/web"

# ─── Preflight checks ──────────────────────────────────────────────
if [ ! -f "$CONTRACTS_DIR/.env" ]; then
  echo "ERROR: $CONTRACTS_DIR/.env not found."
  echo ""
  echo "Create it from the example:"
  echo "  cp $CONTRACTS_DIR/.env.example $CONTRACTS_DIR/.env"
  echo "  # Then edit it and set DEPLOYER_KEY to your private key"
  exit 1
fi

# shellcheck source=/dev/null
source "$CONTRACTS_DIR/.env"

if [ -z "${DEPLOYER_KEY:-}" ] || [ "$DEPLOYER_KEY" = "0x_your_private_key_here" ]; then
  echo "ERROR: DEPLOYER_KEY is not set in $CONTRACTS_DIR/.env"
  echo "Set it to the private key of a wallet with Base Sepolia ETH."
  exit 1
fi

RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

echo "=== Djinn Protocol — Base Sepolia Deployment ==="
echo "RPC: $RPC_URL"
echo ""

# ─── Build contracts ─────────────────────────────────────────────────
echo "Building contracts..."
cd "$CONTRACTS_DIR"
forge build --quiet

# ─── Deploy ──────────────────────────────────────────────────────────
echo "Deploying all contracts (this takes ~60s)..."
echo ""

DEPLOY_OUTPUT=$(forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --slow \
  -vvv 2>&1) || {
  echo "Deployment FAILED. Output:"
  echo "$DEPLOY_OUTPUT"
  exit 1
}

echo "$DEPLOY_OUTPUT" | grep -E "^  (MockUSDC|Account|CreditLedger|SignalCommitment|KeyRecovery|Collateral|Escrow|Audit|OutcomeVoting|NEXT_PUBLIC|AUDIT_|KEY_|All contract|Minted|Deployer|Chain)" || true

echo ""
echo "=== Extracting addresses ==="

# Parse addresses from forge output
extract() {
  echo "$DEPLOY_OUTPUT" | grep -oP "$1:\s*\K0x[0-9a-fA-F]{40}" | head -1
}

USDC_ADDR=$(extract "MockUSDC")
SIGNAL_ADDR=$(extract "SignalCommitment")
ESCROW_ADDR=$(extract "Escrow")
COLLATERAL_ADDR=$(extract "Collateral")
CREDIT_ADDR=$(extract "CreditLedger")
ACCOUNT_ADDR=$(extract "Account")

# Verify we got all addresses
MISSING=""
[ -z "$USDC_ADDR" ] && MISSING="$MISSING MockUSDC"
[ -z "$SIGNAL_ADDR" ] && MISSING="$MISSING SignalCommitment"
[ -z "$ESCROW_ADDR" ] && MISSING="$MISSING Escrow"
[ -z "$COLLATERAL_ADDR" ] && MISSING="$MISSING Collateral"
[ -z "$CREDIT_ADDR" ] && MISSING="$MISSING CreditLedger"
[ -z "$ACCOUNT_ADDR" ] && MISSING="$MISSING Account"

if [ -n "$MISSING" ]; then
  echo "WARNING: Could not extract addresses for:$MISSING"
  echo "Check the deploy output above and update web/.env manually."
  echo ""
  echo "Full deploy output saved to: /tmp/djinn-deploy.log"
  echo "$DEPLOY_OUTPUT" > /tmp/djinn-deploy.log
  exit 1
fi

echo "  USDC:             $USDC_ADDR"
echo "  SignalCommitment: $SIGNAL_ADDR"
echo "  Escrow:           $ESCROW_ADDR"
echo "  Collateral:       $COLLATERAL_ADDR"
echo "  CreditLedger:     $CREDIT_ADDR"
echo "  Account:          $ACCOUNT_ADDR"

# ─── Update web/.env ─────────────────────────────────────────────────
echo ""
echo "=== Updating web/.env ==="

if [ ! -f "$WEB_DIR/.env" ]; then
  echo "WARNING: $WEB_DIR/.env not found, creating from example"
  cp "$WEB_DIR/.env.example" "$WEB_DIR/.env" 2>/dev/null || true
fi

# Update addresses in-place
sed -i "s|^NEXT_PUBLIC_USDC_ADDRESS=.*|NEXT_PUBLIC_USDC_ADDRESS=$USDC_ADDR|" "$WEB_DIR/.env"
sed -i "s|^NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS=.*|NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS=$SIGNAL_ADDR|" "$WEB_DIR/.env"
sed -i "s|^NEXT_PUBLIC_ESCROW_ADDRESS=.*|NEXT_PUBLIC_ESCROW_ADDRESS=$ESCROW_ADDR|" "$WEB_DIR/.env"
sed -i "s|^NEXT_PUBLIC_COLLATERAL_ADDRESS=.*|NEXT_PUBLIC_COLLATERAL_ADDRESS=$COLLATERAL_ADDR|" "$WEB_DIR/.env"
sed -i "s|^NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS=.*|NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS=$CREDIT_ADDR|" "$WEB_DIR/.env"
sed -i "s|^NEXT_PUBLIC_ACCOUNT_ADDRESS=.*|NEXT_PUBLIC_ACCOUNT_ADDRESS=$ACCOUNT_ADDR|" "$WEB_DIR/.env"

# Update RPC to Base Sepolia (not localhost)
sed -i "s|^NEXT_PUBLIC_BASE_RPC_URL=.*|NEXT_PUBLIC_BASE_RPC_URL=https://sepolia.base.org|" "$WEB_DIR/.env"

# Update chain ID comment
sed -i "s|^# Local Anvil fork of Base Sepolia|# Base Sepolia testnet|" "$WEB_DIR/.env"
sed -i "s|^# Contract addresses (deployed on local Anvil)|# Contract addresses (deployed on Base Sepolia)|" "$WEB_DIR/.env"

echo "Done! web/.env updated with new addresses."
echo ""
echo "=== Next steps ==="
echo "1. Rebuild the web app:  cd web && pnpm build"
echo "2. Restart the dev server or redeploy"
echo "3. The deployer wallet has 1M test USDC for testing"
echo ""
echo "Full deploy output saved to: /tmp/djinn-deploy.log"
echo "$DEPLOY_OUTPUT" > /tmp/djinn-deploy.log
