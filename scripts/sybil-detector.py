#!/usr/bin/env python3
"""SN103 Sybil & Anomaly Detector

Runs on cron, queries the live metagraph, and alerts via Telegram when
it detects suspicious patterns: IP clustering, weight collusion, vtrust
drops, incentive concentration, or registration spam.

Cron (every 30 minutes):
  */30 * * * * cd /home/user/djinn/validator && uv run python3 /home/user/djinn/scripts/sybil-detector.py

State is persisted to a JSON file so alerts are only sent on NEW findings.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

NETUID = 103
NETWORK = "finney"
STATE_FILE = Path("/home/user/djinn/scripts/.sybil-detector-state.json")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "1530623518")

# If no env var, read from telegram-bot .env
if not TELEGRAM_BOT_TOKEN:
    _env = Path.home() / "telegram-bot" / ".env"
    if _env.exists():
        for line in _env.read_text().splitlines():
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                TELEGRAM_BOT_TOKEN = line.split("=", 1)[1].strip()
                break

# Thresholds
MAX_MINERS_PER_IP = 8  # alert if single IP runs more than this
MAX_MINERS_PER_SLASH24 = 20  # alert if /24 subnet has more
VTRUST_DROP_THRESHOLD = 0.10  # alert if our vtrust drops by this much
INCENTIVE_GINI_THRESHOLD = 0.85  # alert if Gini coefficient exceeds this
REG_SPIKE_THRESHOLD = 10  # alert if N new registrations since last run
WEIGHT_COLLUSION_THRESHOLD = 0.90  # cosine similarity above this is suspicious
OUR_UIDS = {41}  # our validator UID(s)


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------

def send_telegram(msg: str) -> None:
    """Send a Telegram message. Silent fail on error."""
    if not TELEGRAM_BOT_TOKEN:
        print(f"[NO BOT TOKEN] {msg}")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "parse_mode": "HTML",
        "text": msg,
        "disable_web_page_preview": True,
    }).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"Telegram send failed: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# State persistence
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ---------------------------------------------------------------------------
# Metagraph helpers
# ---------------------------------------------------------------------------

def safe_item(v):
    return v.item() if hasattr(v, "item") else float(v)


def gini_coefficient(values: list[float]) -> float:
    """Compute Gini coefficient (0 = perfect equality, 1 = max inequality)."""
    if not values or sum(values) == 0:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    cumsum = 0.0
    weighted_sum = 0.0
    for i, v in enumerate(sorted_vals):
        cumsum += v
        weighted_sum += (i + 1) * v
    return (2.0 * weighted_sum) / (n * cumsum) - (n + 1) / n


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two weight vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    mag_a = sum(x * x for x in a) ** 0.5
    mag_b = sum(x * x for x in b) ** 0.5
    if mag_a < 1e-12 or mag_b < 1e-12:
        return 0.0
    return dot / (mag_a * mag_b)


# ---------------------------------------------------------------------------
# Detection checks
# ---------------------------------------------------------------------------

@dataclass
class Alert:
    category: str
    severity: str  # LOW, MEDIUM, HIGH, CRITICAL
    message: str


def check_ip_clustering(metagraph, n: int) -> list[Alert]:
    """Detect miners concentrated on single IPs or /24 subnets."""
    alerts = []
    ip_counts: Counter = Counter()
    subnet_counts: Counter = Counter()

    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        if bool(safe_item(permit)):
            continue
        ip = metagraph.axons[uid].ip
        if not ip or ip == "0.0.0.0":
            continue
        ip_counts[ip] += 1
        slash24 = ".".join(ip.split(".")[:3])
        subnet_counts[slash24] += 1

    for ip, count in ip_counts.most_common(20):
        if count > MAX_MINERS_PER_IP:
            alerts.append(Alert(
                "IP_CLUSTER",
                "HIGH" if count > MAX_MINERS_PER_IP * 2 else "MEDIUM",
                f"{ip} running {count} miner UIDs",
            ))

    for subnet, count in subnet_counts.most_common(10):
        if count > MAX_MINERS_PER_SLASH24:
            alerts.append(Alert(
                "SUBNET_CLUSTER",
                "HIGH" if count > MAX_MINERS_PER_SLASH24 * 2 else "MEDIUM",
                f"{subnet}.0/24 has {count} miner UIDs",
            ))

    return alerts


def check_vtrust(metagraph, n: int, prev_state: dict) -> list[Alert]:
    """Alert if our validator vtrust drops significantly."""
    alerts = []
    for our_uid in OUR_UIDS:
        if our_uid >= n:
            continue
        current_vt = safe_item(metagraph.validator_trust[our_uid])
        prev_vt = prev_state.get(f"vtrust_{our_uid}", current_vt)

        if prev_vt - current_vt > VTRUST_DROP_THRESHOLD:
            alerts.append(Alert(
                "VTRUST_DROP",
                "CRITICAL",
                f"UID {our_uid} vtrust dropped {prev_vt:.3f} -> {current_vt:.3f} "
                f"(delta: {prev_vt - current_vt:.3f})",
            ))

    return alerts


def check_incentive_concentration(metagraph, n: int) -> list[Alert]:
    """Detect if incentive is heavily concentrated (high Gini = few winners)."""
    alerts = []
    incentives = []
    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        if bool(safe_item(permit)):
            continue
        incentives.append(safe_item(metagraph.incentive[uid]))

    if len(incentives) < 5:
        return alerts

    gini = gini_coefficient(incentives)
    if gini > INCENTIVE_GINI_THRESHOLD:
        # Find top earners
        uid_incentive = []
        for uid in range(n):
            permit = metagraph.validator_permit[uid]
            if bool(safe_item(permit)):
                continue
            uid_incentive.append((uid, safe_item(metagraph.incentive[uid])))
        uid_incentive.sort(key=lambda x: x[1], reverse=True)
        top5 = ", ".join(f"UID {u}({v:.4f})" for u, v in uid_incentive[:5])

        alerts.append(Alert(
            "INCENTIVE_CONCENTRATION",
            "HIGH" if gini > 0.92 else "MEDIUM",
            f"Gini coefficient {gini:.3f} (threshold: {INCENTIVE_GINI_THRESHOLD}). "
            f"Top 5: {top5}",
        ))

    return alerts


def check_registration_spike(metagraph, n: int, prev_state: dict) -> list[Alert]:
    """Detect batch registrations since last run."""
    alerts = []
    current_hotkeys = set()
    for uid in range(n):
        hk = metagraph.axons[uid].hotkey
        if hk:
            current_hotkeys.add(hk)

    prev_hotkeys = set(prev_state.get("hotkeys", []))
    if prev_hotkeys:
        new_hotkeys = current_hotkeys - prev_hotkeys
        departed = prev_hotkeys - current_hotkeys
        if len(new_hotkeys) >= REG_SPIKE_THRESHOLD:
            # Check if new registrations cluster on few IPs
            new_ips: Counter = Counter()
            for uid in range(n):
                hk = metagraph.axons[uid].hotkey
                if hk in new_hotkeys:
                    ip = metagraph.axons[uid].ip
                    if ip and ip != "0.0.0.0":
                        new_ips[ip] += 1
            ip_summary = ", ".join(f"{ip}({c})" for ip, c in new_ips.most_common(5))
            alerts.append(Alert(
                "REG_SPIKE",
                "HIGH",
                f"{len(new_hotkeys)} new registrations since last check. "
                f"IPs: {ip_summary}",
            ))
        if len(departed) >= REG_SPIKE_THRESHOLD:
            alerts.append(Alert(
                "DEREG_SPIKE",
                "MEDIUM",
                f"{len(departed)} deregistrations since last check",
            ))

    return alerts


def check_weight_collusion(metagraph, n: int) -> list[Alert]:
    """Detect validators setting suspiciously similar weights (potential coordination)."""
    alerts = []
    val_uids = []
    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        if bool(safe_item(permit)):
            stake = safe_item(metagraph.S[uid])
            if stake > 100:  # only check validators with meaningful stake
                val_uids.append(uid)

    if len(val_uids) < 3:
        return alerts

    # Extract weight vectors per validator
    # metagraph.W is the full weight matrix [n x n]
    weight_vectors = {}
    for vid in val_uids:
        if vid in OUR_UIDS:
            continue  # skip self
        try:
            weights = [safe_item(metagraph.W[vid][uid]) for uid in range(n)]
            if sum(weights) > 1e-12:
                weight_vectors[vid] = weights
        except (IndexError, AttributeError):
            continue

    # Check for suspiciously similar pairs (excluding our own)
    vids = list(weight_vectors.keys())
    for i in range(len(vids)):
        for j in range(i + 1, len(vids)):
            sim = cosine_similarity(weight_vectors[vids[i]], weight_vectors[vids[j]])
            if sim > WEIGHT_COLLUSION_THRESHOLD:
                alerts.append(Alert(
                    "WEIGHT_COLLUSION",
                    "HIGH",
                    f"Validators UID {vids[i]} and UID {vids[j]} have "
                    f"cosine similarity {sim:.3f} in weight vectors",
                ))

    return alerts


def check_emission_share(metagraph, n: int) -> list[Alert]:
    """Report UID 0 (burn) emission share and top miner emissions."""
    alerts = []
    total_e = sum(safe_item(metagraph.E[uid]) for uid in range(n))
    if total_e < 1e-12:
        return alerts

    uid0_e = safe_item(metagraph.E[0])
    uid0_pct = uid0_e / total_e * 100

    # Find top 3 non-zero non-validator earners
    miner_emissions = []
    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        if bool(safe_item(permit)) or uid == 0:
            continue
        e = safe_item(metagraph.E[uid])
        if e > 0:
            miner_emissions.append((uid, e))
    miner_emissions.sort(key=lambda x: x[1], reverse=True)

    # Not really an "alert" but useful context in every report
    top3 = ", ".join(
        f"UID {u}({e:.2f}, {e/total_e*100:.1f}%)"
        for u, e in miner_emissions[:3]
    )
    alerts.append(Alert(
        "EMISSION_SNAPSHOT",
        "INFO",
        f"Burn (UID 0): {uid0_pct:.1f}% | Top miners: {top3} | "
        f"Total: {total_e:.2f}",
    ))

    return alerts


def check_ghost_nodes(metagraph, n: int) -> list[Alert]:
    """Detect UIDs with no IP (squatting slots without serving)."""
    alerts = []
    ghost_count = 0
    ghost_ips: Counter = Counter()

    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        if bool(safe_item(permit)):
            continue
        axon = metagraph.axons[uid]
        ip = axon.ip
        if not ip or ip == "0.0.0.0":
            ghost_count += 1
        else:
            # Check for IPs that appear to be dead (no port set)
            if axon.port == 0:
                ghost_count += 1
                ghost_ips[ip] += 1

    if ghost_count > 20:
        alerts.append(Alert(
            "GHOST_NODES",
            "MEDIUM" if ghost_count < 50 else "HIGH",
            f"{ghost_count} miner UIDs with no IP or no port (slot squatting)",
        ))

    return alerts


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    try:
        import bittensor as bt
    except ImportError:
        print("bittensor not installed, run from validator venv", file=sys.stderr)
        sys.exit(1)

    print(f"[{datetime.now(timezone.utc).isoformat()}] SN103 Sybil Detector starting...")

    sub = bt.Subtensor(network=NETWORK)
    mg = sub.metagraph(netuid=NETUID)
    n = int(mg.n.item())
    prev_state = load_state()

    # Run all checks
    all_alerts: list[Alert] = []
    all_alerts.extend(check_ip_clustering(mg, n))
    all_alerts.extend(check_vtrust(mg, n, prev_state))
    all_alerts.extend(check_incentive_concentration(mg, n))
    all_alerts.extend(check_registration_spike(mg, n, prev_state))
    all_alerts.extend(check_weight_collusion(mg, n))
    all_alerts.extend(check_emission_share(mg, n))
    all_alerts.extend(check_ghost_nodes(mg, n))

    # Separate info from real alerts
    info_alerts = [a for a in all_alerts if a.severity == "INFO"]
    real_alerts = [a for a in all_alerts if a.severity != "INFO"]

    # Deduplicate against previous run
    prev_alert_keys = set(prev_state.get("alert_keys", []))
    new_alerts = []
    current_keys = []
    for a in real_alerts:
        key = f"{a.category}:{a.message}"
        current_keys.append(key)
        if key not in prev_alert_keys:
            new_alerts.append(a)

    # Build Telegram message
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if new_alerts:
        severity_emoji = {"LOW": ".", "MEDIUM": "!", "HIGH": "!!", "CRITICAL": "!!!"}
        lines = [f"<b>SN103 Sybil Detector</b> ({now})\n"]

        for a in sorted(new_alerts, key=lambda x: ["LOW", "MEDIUM", "HIGH", "CRITICAL"].index(x.severity), reverse=True):
            sev = severity_emoji.get(a.severity, "")
            lines.append(f"[{a.severity}{sev}] <b>{a.category}</b>: {a.message}")

        # Add emission snapshot as context
        for a in info_alerts:
            lines.append(f"\n[INFO] {a.message}")

        msg = "\n".join(lines)
        send_telegram(msg)
        print(f"Sent {len(new_alerts)} new alerts to Telegram")
    else:
        print(f"No new alerts ({len(real_alerts)} existing, {len(info_alerts)} info)")

    # Print all findings to stdout (for cron log)
    for a in all_alerts:
        print(f"  [{a.severity}] {a.category}: {a.message}")

    # Update state
    new_state = {
        "last_run": now,
        "n": n,
        "alert_keys": current_keys,
        "hotkeys": list(set(
            mg.axons[uid].hotkey for uid in range(n) if mg.axons[uid].hotkey
        )),
    }
    # Save vtrust for our UIDs
    for our_uid in OUR_UIDS:
        if our_uid < n:
            new_state[f"vtrust_{our_uid}"] = safe_item(mg.validator_trust[our_uid])

    save_state(new_state)
    print("State saved.")


if __name__ == "__main__":
    main()
