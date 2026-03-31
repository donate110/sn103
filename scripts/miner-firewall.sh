#!/usr/bin/env bash
# Djinn miner firewall: whitelist validator IPs from the metagraph.
#
# Pulls validator IPs from the Bittensor metagraph and configures ufw
# to only allow those IPs on the miner API port. Blocks all other
# incoming traffic on that port, preventing DDoS from other miners.
#
# Also applies kernel-level SYN flood protection and connection rate
# limiting via sysctl.
#
# Usage:
#   sudo bash scripts/miner-firewall.sh [OPTIONS]
#
# Options:
#   --api-port PORT      Miner API port (default: 8422)
#   --ssh-port PORT      SSH port to keep open (default: 22)
#   --netuid NETUID      Subnet UID (default: 103)
#   --network NETWORK    Bittensor network (default: finney)
#   --dry-run            Print rules without applying them
#   --no-sysctl          Skip kernel hardening
#
# Cron setup (update every 15 minutes):
#   */15 * * * * /path/to/scripts/miner-firewall.sh --quiet 2>&1 | logger -t djinn-firewall
#
# Safe to re-run. Idempotent. Removes stale validator IPs automatically.

set -euo pipefail

API_PORT=8422
SSH_PORT=22
NETUID=103
NETWORK="finney"
DRY_RUN=false
NO_SYSCTL=false
QUIET=false
UFW_COMMENT="djinn-validator"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-port)    API_PORT="$2"; shift 2 ;;
    --ssh-port)    SSH_PORT="$2"; shift 2 ;;
    --netuid)      NETUID="$2"; shift 2 ;;
    --network)     NETWORK="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --no-sysctl)   NO_SYSCTL=true; shift ;;
    --quiet)       QUIET=true; shift ;;
    -h|--help)
      sed -n '2,/^$/s/^# \?//p' "$0"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() { $QUIET || echo "$@"; }

# ── Preflight ──────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]] && ! $DRY_RUN; then
  echo "Error: run as root or with sudo (or use --dry-run)." >&2
  exit 1
fi

if ! command -v ufw &>/dev/null && ! $DRY_RUN; then
  log "Installing ufw..."
  apt-get update -qq && apt-get install -y -qq ufw
fi

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 required to query the metagraph." >&2
  exit 1
fi

# ── Fetch validator IPs from metagraph ─────────────────────────────
log "Fetching validator IPs from subnet $NETUID on $NETWORK..."

VALIDATOR_IPS=$(python3 -c "
import sys
try:
    import bittensor as bt
    sub = bt.Subtensor(network='$NETWORK')
    meta = sub.metagraph(netuid=$NETUID)
    n = meta.n.item() if hasattr(meta.n, 'item') else int(meta.n)
    ips = set()
    for uid in range(n):
        permit = meta.validator_permit[uid]
        if hasattr(permit, 'item'):
            permit = permit.item()
        if not permit:
            continue
        ip = meta.axons[uid].ip
        if ip and ip != '0.0.0.0':
            ips.add(ip)
    for ip in sorted(ips):
        print(ip)
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1)

if [[ $? -ne 0 ]] || [[ -z "$VALIDATOR_IPS" ]]; then
  echo "Error: failed to fetch validator IPs from metagraph." >&2
  echo "$VALIDATOR_IPS" >&2
  exit 1
fi

IP_COUNT=$(echo "$VALIDATOR_IPS" | wc -l)
log "Found $IP_COUNT validator IPs."

if [[ $IP_COUNT -lt 1 ]]; then
  echo "Error: no validator IPs found. Refusing to lock down firewall." >&2
  exit 1
fi

# ── Kernel hardening (sysctl) ──────────────────────────────────────
if ! $NO_SYSCTL && ! $DRY_RUN; then
  log "Applying kernel hardening..."

  SYSCTL_CONF="/etc/sysctl.d/99-djinn-hardening.conf"
  cat > "$SYSCTL_CONF" << 'SYSCTL'
# Djinn miner DDoS hardening (managed by miner-firewall.sh)

# SYN flood protection: use SYN cookies when SYN backlog overflows
net.ipv4.tcp_syncookies = 1

# Increase SYN backlog (default 128 is too small under load)
net.ipv4.tcp_max_syn_backlog = 4096

# Reduce SYN-ACK retries (default 5 = ~180s; 2 = ~15s)
net.ipv4.tcp_synack_retries = 2

# Reverse-path filtering: drop packets with spoofed source IPs
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast pings (smurf attack prevention)
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Log martian packets (packets with impossible source addresses)
net.ipv4.conf.all.log_martians = 1

# Reduce FIN-WAIT timeout (default 60s holds resources during floods)
net.ipv4.tcp_fin_timeout = 15

# Reduce keepalive time (detect dead connections faster)
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_keepalive_probes = 5

# Increase connection tracking table (prevents conntrack overflow under load)
net.netfilter.nf_conntrack_max = 131072
SYSCTL

  sysctl --system -q 2>/dev/null || sysctl -p "$SYSCTL_CONF" 2>/dev/null || true
  log "  Written to $SYSCTL_CONF"
elif $DRY_RUN; then
  log "[dry-run] Would write sysctl hardening to /etc/sysctl.d/99-djinn-hardening.conf"
fi

# ── UFW rules ──────────────────────────────────────────────────────
if $DRY_RUN; then
  log ""
  log "[dry-run] Would apply these ufw rules:"
  log "  ufw default deny incoming"
  log "  ufw default allow outgoing"
  log "  ufw allow $SSH_PORT/tcp (rate-limited)"
  for ip in $VALIDATOR_IPS; do
    log "  ufw allow from $ip to any port $API_PORT proto tcp"
  done
  log "  ufw deny $API_PORT/tcp  (block non-validator traffic)"
  log ""
  log "Validator IPs:"
  echo "$VALIDATOR_IPS"
  exit 0
fi

log "Configuring ufw..."

# Set defaults
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null

# SSH: always open, rate-limited
ufw allow "$SSH_PORT/tcp" >/dev/null 2>&1
ufw limit "$SSH_PORT/tcp" >/dev/null 2>&1

# Remove old validator rules (stale IPs from previous runs)
# ufw status output format: "8422/tcp ALLOW IN 1.2.3.4 # djinn-validator"
ufw status numbered 2>/dev/null | grep "$UFW_COMMENT" | \
  grep -oP '^\[\s*\K\d+' | sort -rn | while read -r num; do
    ufw --force delete "$num" >/dev/null 2>&1 || true
done

# Add current validator IPs
for ip in $VALIDATOR_IPS; do
  ufw allow from "$ip" to any port "$API_PORT" proto tcp \
    comment "$UFW_COMMENT" >/dev/null 2>&1
done

# Deny all other traffic to the API port (must come after allow rules)
# Remove any existing blanket allow on the API port first
ufw delete allow "$API_PORT/tcp" >/dev/null 2>&1 || true
ufw deny "$API_PORT/tcp" comment "$UFW_COMMENT-deny" >/dev/null 2>&1

# Enable
ufw --force enable >/dev/null 2>&1

log ""
log "Firewall configured:"
log "  SSH ($SSH_PORT): open, rate-limited"
log "  API ($API_PORT): $IP_COUNT validator IPs whitelisted, all others blocked"
log ""
if ! $QUIET; then
  ufw status | head -30
fi
log ""
log "To update automatically, add to crontab:"
log "  */15 * * * * $(realpath "$0") --quiet 2>&1 | logger -t djinn-firewall"
