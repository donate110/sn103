#!/usr/bin/env bash
# Monitor DDoS shield deployment and miner health.
# Appends one JSON line per run to shield-metrics.jsonl.
set -euo pipefail

METRICS_FILE="/home/user/djinn/scripts/shield-metrics.jsonl"
VALIDATORS=(
  "34.58.165.14:8421"
  "161.97.150.248:8421"
  "3.150.72.96:8421"
  "167.150.153.103:8421"
)

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
epoch=$(date +%s)

# Collect all metrics from the first responsive validator
python3 << 'PYEOF'
import json, sys, time, urllib.request

VALIDATORS = [
    "34.58.165.14:8421",
    "161.97.150.248:8421",
    "3.150.72.96:8421",
    "167.150.153.103:8421",
]

ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
epoch = int(time.time())

def fetch(url, timeout=10):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except:
        return None

# Validator health
validators_up = 0
validators_down = 0
validator_versions = {}
for v in VALIDATORS:
    h = fetch(f"http://{v}/health", timeout=5)
    if h and h.get("status") == "ok":
        validators_up += 1
        validator_versions[v] = h.get("version", "?")
    else:
        validators_down += 1

# Miner stats from highest-version validator (most up-to-date data)
miners_data = None
best_version = 0
for v in VALIDATORS:
    h = fetch(f"http://{v}/health", timeout=5)
    if not h:
        continue
    ver_str = str(h.get("version", "0") or "0").split("+")[0]
    try:
        ver = int(ver_str)
    except ValueError:
        ver = 0
    md = fetch(f"http://{v}/v1/network/miners")
    if md and md.get("miners") and ver > best_version:
        miners_data = md
        best_version = ver

total = 0
healthy = 0
offline = 0
avg_uptime = 0.0
avg_weight = 0.0
avg_attestation_rate = 0.0
weight_variance = 0.0
low_uptime_miners = 0  # uptime < 0.9 (likely DDoS victims)
zero_attestation_miners = 0
score_data = []

if miners_data and miners_data.get("miners"):
    miners = miners_data["miners"]
    total = len(miners)
    healthy = sum(1 for m in miners if m.get("status") == "ok")
    offline = sum(1 for m in miners if m.get("status") == "offline")

    uptimes = [m.get("uptime", 0) for m in miners]
    weights = [m.get("weight", 0) for m in miners]
    att_rates = []
    for m in miners:
        att_total = m.get("attestations_total", 0)
        att_valid = m.get("attestations_valid", 0)
        if att_total > 0:
            att_rates.append(att_valid / att_total)

    avg_uptime = sum(uptimes) / len(uptimes) if uptimes else 0
    avg_weight = sum(weights) / len(weights) if weights else 0
    avg_attestation_rate = sum(att_rates) / len(att_rates) if att_rates else 0

    # Weight variance (high variance = some miners being punished)
    if weights:
        mean_w = avg_weight
        weight_variance = sum((w - mean_w) ** 2 for w in weights) / len(weights)

    # Miners with low uptime (probable DDoS victims)
    low_uptime_miners = sum(1 for u in uptimes if u < 0.9)

    # Miners with zero valid attestations
    zero_attestation_miners = sum(
        1 for m in miners
        if m.get("attestations_valid", 0) == 0 and m.get("attestations_total", 0) > 0
    )

    # Uptime distribution buckets
    uptime_100 = sum(1 for u in uptimes if u >= 0.99)
    uptime_90 = sum(1 for u in uptimes if 0.9 <= u < 0.99)
    uptime_50 = sum(1 for u in uptimes if 0.5 <= u < 0.9)
    uptime_low = sum(1 for u in uptimes if u < 0.5)

    # Miner version distribution
    miner_versions = {}
    for m in miners:
        v = m.get("version", "") or "unknown"
        miner_versions[v] = miner_versions.get(v, 0) + 1

# Attestation metrics from validators (if available)
attestation_success = 0
attestation_total = 0
for v in VALIDATORS:
    att = fetch(f"http://{v}/v1/metrics/attestations?limit=50")
    if att and att.get("attestations"):
        for a in att["attestations"]:
            attestation_total += 1
            if a.get("status") == "verified" or a.get("verified"):
                attestation_success += 1

attestation_rate = (attestation_success / attestation_total * 100) if attestation_total > 0 else 0

metrics = {
    "ts": ts,
    "epoch": epoch,
    "validators_up": validators_up,
    "validators_down": validators_down,
    "validator_versions": validator_versions,
    "total_miners": total,
    "healthy_miners": healthy,
    "offline_miners": offline,
    "avg_uptime": round(avg_uptime, 4),
    "avg_weight": round(avg_weight, 6),
    "weight_variance": round(weight_variance, 10),
    "avg_attestation_rate": round(avg_attestation_rate, 4),
    "low_uptime_miners": low_uptime_miners,
    "zero_attestation_miners": zero_attestation_miners,
    "uptime_100pct": uptime_100 if miners_data else 0,
    "uptime_90_99pct": uptime_90 if miners_data else 0,
    "uptime_50_89pct": uptime_50 if miners_data else 0,
    "uptime_below_50pct": uptime_low if miners_data else 0,
    "validator_attestation_success": attestation_success,
    "validator_attestation_total": attestation_total,
    "validator_attestation_rate_pct": round(attestation_rate, 1),
    "shielded_miners": miners_data.get("shield", {}).get("shielded_miners", 0) if miners_data else 0,
    "tunnel_active_miners": miners_data.get("shield", {}).get("tunnel_active_miners", 0) if miners_data else 0,
    "miner_versions": miner_versions if miners_data else {},
}

# Track our miner (UID 240) scores from the best validator
our_miner = {}
for v in VALIDATORS:
    try:
        data = fetch(f"http://{v}/v1/miner/240/scores", timeout=8)
        if data and data.get("found"):
            our_miner = {
                "weight": round(data.get("weight", 0), 6),
                "uptime": round(data.get("uptime", 0), 4),
                "attestation_valid": data.get("attestations_valid", 0),
                "attestation_total": data.get("attestations_total", 0),
                "health_responded": data.get("health_checks_responded", 0),
                "health_total": data.get("health_checks_total", 0),
            }
            break
    except:
        pass
metrics["our_miner_240"] = our_miner

# Count shield adoption from miner health responses
shield_count = 0
if miners_data and miners_data.get("miners"):
    for m in miners_data["miners"]:
        # Miners running our code with shield report shield_installed=true
        # But we can't see that from the validator's /network/miners endpoint
        # We'd need to check individual health responses
        pass
metrics["shield_adopted"] = shield_count

with open("/home/user/djinn/scripts/shield-metrics.jsonl", "a") as f:
    f.write(json.dumps(metrics) + "\n")

print(f"[{ts}] validators={validators_up}/{validators_up+validators_down} "
      f"miners={healthy}/{total} healthy, {offline} offline, "
      f"uptime={avg_uptime:.1%}, attest_rate={avg_attestation_rate:.1%}, "
      f"low_uptime={low_uptime_miners}, "
      f"validator_attest={attestation_success}/{attestation_total} ({attestation_rate:.0f}%)")
PYEOF
