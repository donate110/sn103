#!/bin/bash
# PM2 Multi-Miner Setup and Management Script
# Usage: ./scripts/pm2-miner.sh [command] [options]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✗${NC} $1"; }

check_prereqs() {
    local missing=0
    
    if ! command -v pm2 &> /dev/null; then
        log_error "PM2 not found. Install with: npm install -g pm2"
        missing=1
    fi
    
    if ! command -v python &> /dev/null; then
        log_error "Python not found"
        missing=1
    fi
    
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found (needed for Redis)"
        missing=1
    fi
    
    if [[ -z "$ODDS_API_KEY" ]]; then
        log_warn "ODDS_API_KEY not set in environment"
        if [[ -f ./miner/.env ]]; then
            source ./miner/.env 2>/dev/null || true
            if [[ -n "$ODDS_API_KEY" ]]; then
                export ODDS_API_KEY
                log_info "Loaded ODDS_API_KEY from ./miner/.env"
            fi
        fi
    fi
    
    return $missing
}

setup() {
    log_info "Setting up PM2 multi-miner environment..."
    
    # Create logs directory
    mkdir -p logs
    
    # Install miner in editable mode (skip if already installed)
    if python -c "import djinn_miner" 2>/dev/null; then
        log_info "Miner package already installed"
    else
        log_info "Installing miner package..."
        cd miner
        # Try uv first (faster), fall back to pip
        if command -v uv &> /dev/null; then
            uv pip install -e . -q
        else
            python -m pip install -e . -q
        fi
        cd ..
    fi
    
    # Start Redis
    log_info "Starting Redis..."
    ./scripts/pm2-redis.sh start
    
    # Wait for Redis
    sleep 2
    if ! ./scripts/pm2-redis.sh status &>/dev/null; then
        log_error "Redis failed to start"
        exit 1
    fi
    
    log_info "Setup complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Create hotkeys: btcli wallet new_hotkey --wallet.name sn78_21 --wallet.hotkey h01"
    echo "  2. Register on SN103: btcli subnet register --netuid 103 --wallet.name sn78_21 --wallet.hotkey h01"
    echo "  3. Start miners: ./scripts/pm2-miner.sh start"
}

start_all() {
    check_prereqs || exit 1
    
    # Ensure Redis is running
    ./scripts/pm2-redis.sh start
    
    log_info "Starting broadcaster and all miners..."
    pm2 start ecosystem.config.js
    
    echo ""
    log_info "All services started. Monitor with: pm2 monit"
}

start_miners() {
    local miners="$@"
    check_prereqs || exit 1
    
    # Ensure Redis is running
    ./scripts/pm2-redis.sh start
    
    if [[ -z "$miners" ]]; then
        log_error "Specify miners to start: ./scripts/pm2-miner.sh start-miners miner01 miner02"
        exit 1
    fi
    
    # Always need broadcaster
    log_info "Starting broadcaster and miners: $miners"
    pm2 start ecosystem.config.js --only "broadcaster,$miners"
}

stop_all() {
    log_info "Stopping all PM2 processes..."
    pm2 delete all 2>/dev/null || true
    
    log_info "Stopping Redis..."
    ./scripts/pm2-redis.sh stop
}

status() {
    echo "=== Redis ==="
    ./scripts/pm2-redis.sh status || true
    echo ""
    echo "=== PM2 Processes ==="
    pm2 list
    echo ""
    echo "=== Memory Usage ==="
    pm2 jlist 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    total = sum(p.get('monit', {}).get('memory', 0) for p in data)
    print(f'Total PM2 memory: {total / 1024 / 1024:.1f} MB')
    for p in sorted(data, key=lambda x: x.get('monit', {}).get('memory', 0), reverse=True)[:5]:
        mem = p.get('monit', {}).get('memory', 0) / 1024 / 1024
        print(f'  {p[\"name\"]:15} {mem:7.1f} MB')
except:
    pass
" 2>/dev/null || true
}

create_hotkeys() {
    local wallet="${BT_WALLET_NAME:-sn78_21}"
    local count="${1:-20}"
    
    log_info "Creating $count hotkeys for wallet $wallet..."
    
    for i in $(seq -w 1 $count); do
        hotkey="h$i"
        if btcli wallet list 2>/dev/null | grep -q "$hotkey"; then
            log_info "Hotkey $hotkey already exists"
        else
            log_info "Creating hotkey $hotkey..."
            btcli wallet new_hotkey --wallet.name "$wallet" --wallet.hotkey "$hotkey" --no-password
        fi
    done
    
    echo ""
    log_info "Hotkeys created. Now register each on SN103:"
    echo "  btcli subnet register --netuid 103 --wallet.name $wallet --wallet.hotkey h01"
}

health_check() {
    echo "Checking miner health endpoints..."
    for i in $(seq 1 20); do
        port=$((15600 + i))
        num=$(printf "%02d" $i)
        if curl -s -f "http://localhost:$port/health" >/dev/null 2>&1; then
            resp=$(curl -s "http://localhost:$port/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"{d.get('status', '?')} uid={d.get('uid', '?')} bt={d.get('bt_connected', '?')}\")
" 2>/dev/null || echo "parse error")
            log_info "miner$num: $resp"
        else
            log_warn "miner$num: not responding on port $port"
        fi
    done
}

usage() {
    cat << EOF
PM2 Multi-Miner Management

Usage: $0 <command> [options]

Commands:
  setup           Install dependencies, start Redis, prepare environment
  start           Start broadcaster and all 20 miners
  start-miners    Start specific miners: start-miners miner01 miner02 miner03
  stop            Stop all processes and Redis
  restart         Restart all processes
  status          Show status of all services
  logs <name>     Follow logs for a service (e.g., logs miner01)
  monit           Open PM2 monitor dashboard
  health          Check health endpoints for all miners
  create-hotkeys  Create h01-h20 hotkeys (or specify count: create-hotkeys 5)

Examples:
  $0 setup                           # First-time setup
  $0 start                          # Start everything
  $0 start-miners miner01 miner02   # Start only specific miners
  $0 logs broadcaster               # View broadcaster logs
  $0 health                         # Check all miner health endpoints

Environment:
  ODDS_API_KEY      Your Odds API key (or set in ./miner/.env)
  BT_WALLET_NAME    Wallet name (default: sn78_21)
  REDIS_URL         Redis URL (default: redis://localhost:6379)
EOF
}

case "$1" in
    setup)
        setup
        ;;
    start)
        start_all
        ;;
    start-miners)
        shift
        start_miners "$@"
        ;;
    stop)
        stop_all
        ;;
    restart)
        stop_all
        sleep 2
        start_all
        ;;
    status)
        status
        ;;
    logs)
        pm2 logs "$2" --lines 100
        ;;
    monit)
        pm2 monit
        ;;
    health)
        health_check
        ;;
    create-hotkeys)
        create_hotkeys "$2"
        ;;
    *)
        usage
        exit 1
        ;;
esac
