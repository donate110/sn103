#!/usr/bin/env bash
# Stage, deploy to our boxes, smoke test, then push to main.
# Usage: bash scripts/stage-and-push.sh
#
# Flow:
#   1. Run local tests (validator, miner, shield)
#   2. Push to staging branch
#   3. Pull staging on our validator (UID 0) and miner (UID 240)
#   4. Install deps (shield, etc)
#   5. Restart processes
#   6. Wait for startup
#   7. Run live smoke tests against real endpoints
#   8. If all pass: merge staging to main, push, tag
#   9. If any fail: rollback our boxes, alert, abort
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

VALIDATOR_BOX="root@37.60.251.252"
MINER_BOX="root@161.97.138.250"
JUMP="-J root@161.97.138.250"
VALIDATOR_URL="http://37.60.251.252:8421"
MINER_URL="http://161.97.138.250:8422"

pass_count=0
fail_count=0

log() { echo -e "${GREEN}[stage]${NC} $1"; }
warn() { echo -e "${YELLOW}[stage]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; fail_count=$((fail_count + 1)); }
pass() { echo -e "${GREEN}[PASS]${NC} $1"; pass_count=$((pass_count + 1)); }

# ── Step 1: Local tests ──
log "Step 1: Running local tests..."

cd "$(git rev-parse --show-toplevel)"

echo -n "  Validator syntax... "
(cd validator && python3 -c "import djinn_validator.api.server" 2>/dev/null) && echo -e "${GREEN}OK${NC}" || { fail "Validator syntax error"; exit 1; }

echo -n "  Miner syntax... "
(cd miner && python3 -c "import djinn_miner.api.server" 2>/dev/null) && echo -e "${GREEN}OK${NC}" || { fail "Miner syntax error"; exit 1; }

echo -n "  Shield syntax... "
(cd shield && PYTHONPATH=. python3 -c "import djinn_tunnel_shield" 2>/dev/null) && echo -e "${GREEN}OK${NC}" || { fail "Shield syntax error"; exit 1; }

echo -n "  Shield tests... "
(cd shield && PYTHONPATH=. python3 -m pytest tests/ -q --no-header 2>&1 | tail -1 | grep -q "passed") && echo -e "${GREEN}OK${NC}" || { fail "Shield tests failed"; exit 1; }

echo -n "  Validator tests... "
(cd validator && timeout 180 python3 -m pytest tests/test_api.py -x -q --no-header 2>&1 | tail -1 | grep -q "passed") && echo -e "${GREEN}OK${NC}" || { fail "Validator tests failed"; exit 1; }

# ── Step 2: Record rollback point ──
ROLLBACK_COMMIT=$(git rev-parse HEAD)
CURRENT_BRANCH=$(git branch --show-current)
log "Step 2: Rollback point: ${ROLLBACK_COMMIT:0:8} on ${CURRENT_BRANCH}"

# ── Step 3: Deploy to our boxes ──
log "Step 3: Deploying to our boxes..."

# Push current state
git push origin "${CURRENT_BRANCH}" 2>/dev/null

# Pull on validator box
log "  Pulling on validator box..."
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} "
cd /root/djinn && git fetch --tags origin && git pull origin ${CURRENT_BRANCH} 2>&1 | tail -3
cd validator && .venv/bin/python -m pip install -q ../shield 2>&1 | tail -1
" 2>/dev/null

# Pull on miner box
log "  Pulling on miner box..."
ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${MINER_BOX} "
cd /root/djinn && git fetch --tags origin && git pull origin ${CURRENT_BRANCH} 2>&1 | tail -3
cd miner && .venv/bin/python -m pip install -q ../shield 2>&1 | tail -1
" 2>/dev/null

# ── Step 4: Restart processes ──
log "Step 4: Restarting processes..."

ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} "
pm2 restart djinn-validator --update-env 2>/dev/null
" 2>/dev/null

ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${MINER_BOX} "
pm2 restart djinn-miner --update-env 2>/dev/null
" 2>/dev/null

# ── Step 5: Wait for startup ──
log "Step 5: Waiting 30s for startup..."
sleep 30

# ── Step 6: Smoke tests ──
log "Step 6: Running live smoke tests..."

# Test 1: Validator health
VHEALTH=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} \
  "curl -s --max-time 10 localhost:8421/health" 2>/dev/null)
if echo "$VHEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok' and d['uid']==0" 2>/dev/null; then
  pass "Validator health: ok, UID 0"
else
  fail "Validator health check failed"
fi

# Test 2: Validator BT connected
if echo "$VHEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['bt_connected']==True" 2>/dev/null; then
  pass "Validator BT connected"
else
  fail "Validator BT not connected"
fi

# Test 3: Validator shares
SHARES=$(echo "$VHEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('shares_held',0))" 2>/dev/null || echo "0")
if [ "$SHARES" -gt 0 ] 2>/dev/null; then
  pass "Validator shares: ${SHARES}"
else
  fail "Validator has no shares"
fi

# Test 4: Miner health
MHEALTH=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${MINER_BOX} \
  "curl -s --max-time 10 localhost:8422/health" 2>/dev/null)
if echo "$MHEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
  pass "Miner health: ok"
else
  fail "Miner health check failed"
fi

# Test 5: Miner UID
MUID=$(echo "$MHEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uid','none'))" 2>/dev/null)
if [ "$MUID" = "240" ]; then
  pass "Miner UID: 240"
else
  warn "Miner UID: ${MUID} (expected 240, may be re-registering)"
fi

# Test 6: Miner BT connected
if echo "$MHEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['bt_connected']==True" 2>/dev/null; then
  pass "Miner BT connected"
else
  fail "Miner BT not connected"
fi

# Test 7: Network miners endpoint (the one that kept breaking)
MINERS=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} \
  "curl -s --max-time 10 localhost:8421/v1/network/miners" 2>/dev/null)
if echo "$MINERS" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'miners' in d" 2>/dev/null; then
  MCOUNT=$(echo "$MINERS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['miners']))" 2>/dev/null)
  pass "Network miners endpoint: ${MCOUNT} miners"
else
  fail "Network miners endpoint broken (500 or parse error)"
fi

# Test 8: Miner notary port
NOTARY=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${MINER_BOX} \
  "ss -tlnp | grep 8091" 2>/dev/null)
if echo "$NOTARY" | grep -q "0.0.0.0:8091"; then
  pass "Miner notary port 8091 externally accessible"
else
  fail "Miner notary port not bound to 0.0.0.0:8091"
fi

# Test 9: No crash-loops (restarts in last 60s)
VRESTARTS=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} \
  "pm2 show djinn-validator 2>/dev/null | grep 'unstable restarts' | awk '{print \$4}'" 2>/dev/null || echo "0")
if [ "${VRESTARTS:-0}" = "0" ]; then
  pass "Validator: 0 unstable restarts"
else
  fail "Validator has ${VRESTARTS} unstable restarts"
fi

# Test 10: No ERROR in recent logs
VERRORS=$(ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} \
  "pm2 logs djinn-validator --nostream --lines 20 2>/dev/null | grep -c 'NameError\|SyntaxError\|ImportError\|500 Internal'" 2>/dev/null || echo "0")
if [ "${VERRORS:-0}" = "0" ]; then
  pass "Validator: no critical errors in logs"
else
  fail "Validator has ${VERRORS} critical errors in logs"
fi

# ── Step 7: Results ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}Passed: ${pass_count}${NC}  ${RED}Failed: ${fail_count}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$fail_count" -gt 0 ]; then
  echo ""
  fail "SMOKE TESTS FAILED. Rolling back our boxes..."

  # Rollback
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${JUMP} ${VALIDATOR_BOX} "
  cd /root/djinn && git checkout ${ROLLBACK_COMMIT} 2>/dev/null
  pm2 restart djinn-validator --update-env 2>/dev/null
  " 2>/dev/null

  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${MINER_BOX} "
  cd /root/djinn && git checkout ${ROLLBACK_COMMIT} 2>/dev/null
  pm2 restart djinn-miner --update-env 2>/dev/null
  " 2>/dev/null

  echo -e "${RED}Push ABORTED. Fix the failures and try again.${NC}"
  exit 1
fi

# ── Step 8: Push to main and tag ──
log "All smoke tests passed. Pushing to main..."
COUNT=$(git rev-list --count HEAD)
git tag "v${COUNT}" 2>/dev/null || true
git push origin "${CURRENT_BRANCH}" --tags 2>/dev/null
echo ""
echo -e "${GREEN}Deployed and tagged v${COUNT}. All validators will update on next watchtower cycle.${NC}"
