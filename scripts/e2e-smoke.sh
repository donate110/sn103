#!/usr/bin/env bash
# Autonomous E2E smoke test: tests the full Djinn stack without on-chain transactions.
# Run via cron or manually. Sends Telegram alert on failure.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass_count=0
fail_count=0
failures=""

pass() { echo -e "${GREEN}[PASS]${NC} $1"; pass_count=$((pass_count + 1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; fail_count=$((fail_count + 1)); failures="${failures}\n- $1"; }

VALIDATORS=(
  "34.58.165.14:8421"
  "161.97.150.248:8421"
  "3.150.72.96:8421"
  "167.150.153.103:8421"
  "37.60.251.252:8421"
)
MINER_URL="http://161.97.138.250:8422"
WEBSITE="https://www.djinn.gg"

echo "=== Djinn E2E Smoke Test $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# ── Validators ──
for v in "${VALIDATORS[@]}"; do
  health=$(curl -s --max-time 8 "http://$v/health" 2>/dev/null || echo "")
  if echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
    pass "Validator $v: healthy"
  else
    fail "Validator $v: not healthy"
  fi
done

# ── Our validator (UID 0) specifics ──
v0_health=$(curl -s --max-time 8 "http://37.60.251.252:8421/health" 2>/dev/null || echo "{}")
uid=$(echo "$v0_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uid','?'))" 2>/dev/null || echo "?")
if [ "$uid" = "0" ]; then pass "Our validator: UID 0"; else fail "Our validator: wrong UID ($uid)"; fi

shares=$(echo "$v0_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('shares_held',0))" 2>/dev/null || echo "0")
if [ "$shares" -gt 0 ] 2>/dev/null; then pass "Our validator: $shares shares"; else fail "Our validator: no shares"; fi

# ── Network miners endpoint ──
miners_data=$(curl -s --max-time 10 "http://37.60.251.252:8421/v1/network/miners" 2>/dev/null || echo "{}")
miner_count=$(echo "$miners_data" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('miners',[])))" 2>/dev/null || echo "0")
if [ "$miner_count" -gt 200 ] 2>/dev/null; then
  pass "Network miners: $miner_count"
else
  fail "Network miners: only $miner_count (expected 200+)"
fi

# ── Our miner (UID 240) ──
# Use SSH to check miner health (dev box may not be in the firewall allow list)
miner_health=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@161.97.138.250 "curl -s localhost:8422/health" 2>/dev/null || echo "{}")
miner_status=$(echo "$miner_health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
miner_uid=$(echo "$miner_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('uid','?'))" 2>/dev/null || echo "?")
miner_bt=$(echo "$miner_health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('bt_connected',False))" 2>/dev/null || echo "False")

if [ "$miner_status" = "ok" ]; then pass "Miner UID $miner_uid: healthy"; else fail "Miner: status=$miner_status"; fi
if [ "$miner_bt" = "True" ]; then pass "Miner: BT connected"; else fail "Miner: BT not connected"; fi

# ── Miner scores from validators ──
score_count=0
for v in "${VALIDATORS[@]}"; do
  score=$(curl -s --max-time 8 "http://$v/v1/miner/240/scores" 2>/dev/null || echo "{}")
  found=$(echo "$score" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found',False))" 2>/dev/null || echo "False")
  if [ "$found" = "True" ]; then score_count=$((score_count + 1)); fi
done
if [ "$score_count" -ge 2 ]; then
  pass "Miner scored by $score_count validators"
else
  fail "Miner only scored by $score_count validators (need 2+)"
fi

# ── Website ──
web_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$WEBSITE" 2>/dev/null || echo "000")
if [ "$web_status" = "200" ] || [ "$web_status" = "403" ]; then pass "Website: HTTP $web_status (up)"; else fail "Website: HTTP $web_status"; fi

# ── API endpoints ──
odds_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$WEBSITE/api/odds?sport=basketball_nba" 2>/dev/null || echo "000")
if [ "$odds_status" = "200" ] || [ "$odds_status" = "403" ]; then pass "Odds API: HTTP $odds_status (up)"; else fail "Odds API: HTTP $odds_status"; fi

# ── Metrics endpoint (was broken by NameError) ──
metrics_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://37.60.251.252:8421/v1/metrics/attestations?limit=5" 2>/dev/null || echo "000")
if [ "$metrics_status" = "200" ]; then pass "Metrics API: 200 OK"; else fail "Metrics API: HTTP $metrics_status"; fi

# ── Summary ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}Passed: ${pass_count}${NC}  ${RED}Failed: ${fail_count}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Alert on failure ──
if [ "$fail_count" -gt 0 ] && [ -f /home/user/telegram-bot/.env ]; then
  source /home/user/telegram-bot/.env
  python3 ~/telegram-bot/send.py --chat-id 1530623518 "E2E Smoke FAILED ($fail_count failures):$(echo -e "$failures")"
fi

exit "$fail_count"
