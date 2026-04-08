#!/bin/bash
# Multi-Miner Launcher — runs N miners with shared odds cache
#
# Usage:
#   ./scripts/run-multi-miner.sh 20          # Run 20 miners
#   ./scripts/run-multi-miner.sh 20 --dry-run # Show what would run
#   ./scripts/run-multi-miner.sh stop        # Stop all miners
#
# Prerequisites:
#   1. Redis running: docker run -d --name redis -p 6379:6379 redis:alpine
#   2. Hotkeys created: btcli wallet new_hotkey --wallet.name miner --wallet.hotkey h01..h20
#   3. Hotkeys registered on SN103
#   4. ODDS_API_KEY set in environment or .env

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MINER_DIR="$PROJECT_DIR/miner"

# Configuration
WALLET_NAME="${BT_WALLET_NAME:-miner}"
BASE_API_PORT="${BASE_API_PORT:-15600}"
BASE_NOTARY_PORT="${BASE_NOTARY_PORT:-7040}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
LOG_DIR="${LOG_DIR:-$PROJECT_DIR/logs}"
BROADCASTER_PID_FILE="$LOG_DIR/broadcaster.pid"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARN:${NC} $*"; }
error() { echo -e "${RED}[$(date '+%H:%M:%S')] ERROR:${NC} $*" >&2; }

usage() {
    echo "Usage: $0 <num_miners|stop> [--dry-run]"
    echo ""
    echo "Commands:"
    echo "  <number>   Start N miners (e.g., 20)"
    echo "  stop       Stop all running miners and broadcaster"
    echo "  status     Show status of all miners"
    echo ""
    echo "Options:"
    echo "  --dry-run  Show what would be executed without running"
    echo ""
    echo "Environment:"
    echo "  BT_WALLET_NAME     Wallet name (default: miner)"
    echo "  BASE_API_PORT      Starting API port (default: 15600)"
    echo "  BASE_NOTARY_PORT   Starting notary port (default: 7040)"
    echo "  REDIS_URL          Redis connection URL"
    echo "  ODDS_API_KEY       The Odds API key (for broadcaster)"
    exit 1
}

check_redis() {
    if ! redis-cli -u "$REDIS_URL" ping &>/dev/null; then
        error "Redis not reachable at $REDIS_URL"
        echo "Start Redis with: docker run -d --name redis -p 6379:6379 redis:alpine"
        exit 1
    fi
    log "Redis connected at $REDIS_URL"
}

check_odds_api_key() {
    if [[ -z "$ODDS_API_KEY" ]]; then
        # Try loading from .env
        if [[ -f "$MINER_DIR/.env" ]]; then
            source "$MINER_DIR/.env"
        fi
    fi
    if [[ -z "$ODDS_API_KEY" ]]; then
        error "ODDS_API_KEY not set"
        exit 1
    fi
    log "Odds API key configured"
}

start_broadcaster() {
    local dry_run=$1
    
    mkdir -p "$LOG_DIR"
    
    if [[ -f "$BROADCASTER_PID_FILE" ]] && kill -0 "$(cat "$BROADCASTER_PID_FILE")" 2>/dev/null; then
        log "Broadcaster already running (PID $(cat "$BROADCASTER_PID_FILE"))"
        return 0
    fi
    
    local cmd="cd $MINER_DIR && ODDS_API_KEY=$ODDS_API_KEY REDIS_URL=$REDIS_URL uv run python -m djinn_miner.data.odds_broadcaster"
    
    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would start broadcaster:"
        echo "  $cmd"
        return 0
    fi
    
    log "Starting odds broadcaster..."
    cd "$MINER_DIR"
    ODDS_API_KEY="$ODDS_API_KEY" REDIS_URL="$REDIS_URL" \
        nohup uv run python -m djinn_miner.data.odds_broadcaster \
        > "$LOG_DIR/broadcaster.log" 2>&1 &
    echo $! > "$BROADCASTER_PID_FILE"
    log "Broadcaster started (PID $!), logs: $LOG_DIR/broadcaster.log"
    
    # Wait for first broadcast
    sleep 3
    if ! kill -0 "$(cat "$BROADCASTER_PID_FILE")" 2>/dev/null; then
        error "Broadcaster failed to start. Check $LOG_DIR/broadcaster.log"
        exit 1
    fi
}

start_miner() {
    local idx=$1
    local dry_run=$2
    
    local hotkey="h$(printf '%02d' $idx)"
    local api_port=$((BASE_API_PORT + idx))
    local notary_port=$((BASE_NOTARY_PORT + idx))
    local log_file="$LOG_DIR/miner-$hotkey.log"
    local pid_file="$LOG_DIR/miner-$hotkey.pid"
    
    # Check if already running
    if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        log "Miner $hotkey already running (PID $(cat "$pid_file"))"
        return 0
    fi
    
    local env_vars="BT_WALLET_NAME=$WALLET_NAME BT_WALLET_HOTKEY=$hotkey"
    env_vars+=" API_PORT=$api_port NOTARY_PORT=$notary_port"
    env_vars+=" SPORTS_DATA_PROVIDER=djinn_miner.data.redis_provider.RedisOddsProvider"
    env_vars+=" REDIS_URL=$REDIS_URL ODDS_L1_TTL=5 ODDS_FALLBACK_API=false"
    
    if [[ "$dry_run" == "true" ]]; then
        echo "[DRY RUN] Would start miner $hotkey:"
        echo "  Port: $api_port, Notary: $notary_port"
        echo "  Hotkey: $hotkey"
        return 0
    fi
    
    log "Starting miner $hotkey on port $api_port..."
    cd "$MINER_DIR"
    
    BT_WALLET_NAME="$WALLET_NAME" \
    BT_WALLET_HOTKEY="$hotkey" \
    API_PORT="$api_port" \
    NOTARY_PORT="$notary_port" \
    SPORTS_DATA_PROVIDER="djinn_miner.data.redis_provider.RedisOddsProvider" \
    REDIS_URL="$REDIS_URL" \
    ODDS_L1_TTL=5 \
    ODDS_FALLBACK_API=false \
        nohup uv run python -m djinn_miner \
        > "$log_file" 2>&1 &
    
    echo $! > "$pid_file"
    log "Miner $hotkey started (PID $!)"
}

stop_all() {
    log "Stopping all miners..."
    
    # Stop miners
    for pid_file in "$LOG_DIR"/miner-*.pid; do
        [[ -f "$pid_file" ]] || continue
        local pid=$(cat "$pid_file")
        local name=$(basename "$pid_file" .pid)
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            log "Stopped $name (PID $pid)"
        fi
        rm -f "$pid_file"
    done
    
    # Stop broadcaster
    if [[ -f "$BROADCASTER_PID_FILE" ]]; then
        local pid=$(cat "$BROADCASTER_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            log "Stopped broadcaster (PID $pid)"
        fi
        rm -f "$BROADCASTER_PID_FILE"
    fi
    
    log "All processes stopped"
}

show_status() {
    echo "=== Broadcaster ==="
    if [[ -f "$BROADCASTER_PID_FILE" ]] && kill -0 "$(cat "$BROADCASTER_PID_FILE")" 2>/dev/null; then
        echo "  Status: RUNNING (PID $(cat "$BROADCASTER_PID_FILE"))"
    else
        echo "  Status: STOPPED"
    fi
    
    echo ""
    echo "=== Miners ==="
    for pid_file in "$LOG_DIR"/miner-*.pid; do
        [[ -f "$pid_file" ]] || continue
        local name=$(basename "$pid_file" .pid)
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "  $name: RUNNING (PID $pid)"
        else
            echo "  $name: STOPPED (stale PID file)"
        fi
    done
    
    echo ""
    echo "=== Redis Cache Stats ==="
    redis-cli -u "$REDIS_URL" --no-raw GET djinn:odds:broadcaster:health 2>/dev/null || echo "  (broadcaster not reporting)"
}

# Main
[[ $# -lt 1 ]] && usage

CMD="$1"
DRY_RUN="false"
[[ "$2" == "--dry-run" ]] && DRY_RUN="true"

mkdir -p "$LOG_DIR"

case "$CMD" in
    stop)
        stop_all
        ;;
    status)
        show_status
        ;;
    [0-9]*)
        NUM_MINERS="$CMD"
        if [[ ! "$NUM_MINERS" =~ ^[0-9]+$ ]] || [[ "$NUM_MINERS" -lt 1 ]] || [[ "$NUM_MINERS" -gt 100 ]]; then
            error "Invalid number of miners: $NUM_MINERS (must be 1-100)"
            exit 1
        fi
        
        log "Starting $NUM_MINERS miners with shared odds cache"
        [[ "$DRY_RUN" == "true" ]] && log "(DRY RUN MODE)"
        
        [[ "$DRY_RUN" == "false" ]] && check_redis
        check_odds_api_key
        
        # Start broadcaster first
        start_broadcaster "$DRY_RUN"
        
        # Start miners
        for i in $(seq 1 "$NUM_MINERS"); do
            start_miner "$i" "$DRY_RUN"
            # Stagger starts to avoid registration collisions
            [[ "$DRY_RUN" == "false" ]] && sleep 2
        done
        
        log "All $NUM_MINERS miners started"
        log "Monitor with: tail -f $LOG_DIR/*.log"
        log "Stop with: $0 stop"
        ;;
    *)
        usage
        ;;
esac
