#!/usr/bin/env bash
# Configure ufw firewall for a Djinn miner.
#
# Opens only the ports the miner needs (API + Notary + SSH),
# denies everything else, and rate-limits SSH.
#
# Usage:
#   bash scripts/miner-firewall.sh [--api-port 8422] [--notary-port 7047] [--ssh-port 22]
#
# Run as root or with sudo. Safe to re-run (ufw is idempotent).

set -euo pipefail

API_PORT=8422
NOTARY_PORT=7047
SSH_PORT=22

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port)    API_PORT="$2"; shift 2 ;;
    --notary-port) NOTARY_PORT="$2"; shift 2 ;;
    --ssh-port)    SSH_PORT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--api-port PORT] [--notary-port PORT] [--ssh-port PORT]"
      echo ""
      echo "Configures ufw to allow only miner traffic:"
      echo "  SSH (default 22)     - remote access, rate-limited"
      echo "  API (default 8422)   - validator challenges and health checks"
      echo "  Notary (default 7047) - peer notary MPC attestation sessions"
      echo ""
      echo "All other incoming traffic is silently dropped."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Check for root/sudo
if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (or with sudo)."
  exit 1
fi

# Check ufw is installed
if ! command -v ufw &>/dev/null; then
  echo "ufw not found. Installing..."
  apt-get update -qq && apt-get install -y -qq ufw
fi

echo "Configuring ufw firewall for Djinn miner..."
echo "  SSH port:    $SSH_PORT"
echo "  API port:    $API_PORT"
echo "  Notary port: $NOTARY_PORT"
echo ""

# Set defaults
ufw default deny incoming
ufw default allow outgoing

# Allow and rate-limit SSH (prevents brute-force; max 6 connections per 30s per IP)
ufw allow "$SSH_PORT/tcp"
ufw limit "$SSH_PORT/tcp"

# Miner API: validators send health checks, line queries, attestation challenges
ufw allow "$API_PORT/tcp"

# Notary sidecar: peer miners connect for MPC attestation sessions
ufw allow "$NOTARY_PORT/tcp"

# Enable (--force skips the interactive prompt)
ufw --force enable

echo ""
echo "Firewall configured. Current rules:"
echo ""
ufw status verbose
echo ""
echo "Done. Only ports $SSH_PORT, $API_PORT, and $NOTARY_PORT accept incoming connections."
echo "All other ports are silently dropped (no response to port scans)."
