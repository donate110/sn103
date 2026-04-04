"""Automatic firewall management for Djinn miners.

On startup and every REFRESH_INTERVAL seconds, extracts validator IPs
from the metagraph and configures ufw to whitelist only those IPs on
the miner's API port. All other incoming traffic on that port is
blocked at the kernel level.

Also applies kernel sysctl hardening (SYN cookies, connection rate
limiting, spoofed-source-IP filtering) on first run.

Requires root. If not running as root, logs a warning and skips
firewall management (the miner still works, just unprotected).

Designed to be launched as an asyncio background task from main.py.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from typing import Any

import structlog

log = structlog.get_logger()

# How often to refresh validator IPs (seconds)
REFRESH_INTERVAL = 900  # 15 minutes

# ufw comment tag for managed rules (used to identify and clean stale rules)
UFW_TAG = "djinn-validator"


def _is_root() -> bool:
    return os.geteuid() == 0


def _has_ufw() -> bool:
    return shutil.which("ufw") is not None


def _run(cmd: list[str], check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def _get_validator_ips(neuron: Any) -> set[str]:
    """Extract validator IPs from the miner's metagraph."""
    if neuron is None or neuron.metagraph is None:
        return set()
    ips: set[str] = set()
    try:
        n = neuron.metagraph.n
        if hasattr(n, "item"):
            n = n.item()
        for uid in range(int(n)):
            permit = neuron.metagraph.validator_permit[uid]
            if hasattr(permit, "item"):
                permit = permit.item()
            if not permit:
                continue
            axon = neuron.metagraph.axons[uid]
            ip = getattr(axon, "ip", "")
            if ip and ip != "0.0.0.0":
                ips.add(ip)
    except Exception as e:
        log.warning("firewall_get_validator_ips_error", error=str(e))
    return ips


def _get_current_allowed_ips(api_port: int) -> set[str]:
    """Parse ufw status to find IPs currently allowed on the API port."""
    result = _run(["ufw", "status"])
    if result.returncode != 0:
        return set()
    ips: set[str] = set()
    for line in result.stdout.splitlines():
        if UFW_TAG in line and str(api_port) in line and "ALLOW" in line:
            # Format: "8422/tcp ALLOW IN 1.2.3.4 # djinn-validator"
            parts = line.split()
            for part in parts:
                if part.count(".") == 3 and part[0].isdigit():
                    ips.add(part)
                    break
    return ips


def apply_sysctl_hardening() -> bool:
    """Write kernel hardening sysctl config. Returns True if applied."""
    if not _is_root():
        return False

    conf_path = "/etc/sysctl.d/99-djinn-hardening.conf"
    conf = """\
# Djinn miner DDoS hardening (auto-managed)
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_synack_retries = 2
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_keepalive_probes = 5
"""
    # Also try conntrack, but don't fail if module not loaded
    conf += "net.netfilter.nf_conntrack_max = 131072\n"

    try:
        # Only rewrite if changed
        existing = ""
        if os.path.exists(conf_path):
            with open(conf_path) as f:
                existing = f.read()
        if existing == conf:
            return True
        with open(conf_path, "w") as f:
            f.write(conf)
        _run(["sysctl", "--system", "-q"])
        log.info("sysctl_hardening_applied", path=conf_path)
        return True
    except Exception as e:
        log.warning("sysctl_hardening_failed", error=str(e))
        return False


def _manage_port(validator_ips: set[str], port: int, tag: str) -> tuple[int, int]:
    """Manage ufw rules for a single port. Returns (added, removed) counts."""
    current_ips = _get_current_allowed_ips(port)

    stale = current_ips - validator_ips
    for ip in stale:
        _run(["ufw", "delete", "allow", "from", ip, "to", "any", "port", str(port), "proto", "tcp"])
        log.info("firewall_removed_stale_ip", ip=ip, port=port)

    new = validator_ips - current_ips
    for ip in new:
        _run(["ufw", "allow", "from", ip, "to", "any", "port", str(port), "proto", "tcp",
               "comment", tag])
        log.info("firewall_added_validator_ip", ip=ip, port=port)

    # Ensure blanket deny is AFTER all allow rules.
    _run(["ufw", "delete", "allow", f"{port}/tcp"])
    _run(["ufw", "delete", "deny", f"{port}/tcp"])
    _run(["ufw", "deny", f"{port}/tcp", "comment", f"{tag}-deny"])

    return len(new), len(stale)


def update_firewall(validator_ips: set[str], api_port: int) -> bool:
    """Update ufw rules to whitelist only the given validator IPs.

    Manages both the API port and the notary sidecar port (8091).
    Returns True if rules were updated successfully.
    """
    if not _is_root() or not _has_ufw():
        return False

    if not validator_ips:
        log.warning("firewall_no_validator_ips", msg="No validator IPs found; skipping firewall update")
        return False

    # Ensure ufw is enabled with sane defaults
    _run(["ufw", "default", "deny", "incoming"])
    _run(["ufw", "default", "allow", "outgoing"])

    # SSH: always allowed and rate-limited
    ssh_port = os.getenv("SSH_PORT", "22")
    _run(["ufw", "allow", f"{ssh_port}/tcp"])
    _run(["ufw", "limit", f"{ssh_port}/tcp"])

    # Manage API port
    api_added, api_removed = _manage_port(validator_ips, api_port, UFW_TAG)

    # Manage notary sidecar port (peer miners connect here for notarization)
    notary_port = int(os.getenv("NOTARY_PORT", "8091"))
    notary_added, notary_removed = _manage_port(validator_ips, notary_port, "djinn-notary")

    # Enable (idempotent, --force skips interactive prompt)
    _run(["ufw", "--force", "enable"])

    total_new = api_added + notary_added
    total_stale = api_removed + notary_removed
    if total_new or total_stale:
        log.info("firewall_updated",
                 total_validators=len(validator_ips),
                 added=total_new, removed=total_stale,
                 ports=[api_port, notary_port])
    return True


async def firewall_loop(neuron: Any, api_port: int) -> None:
    """Background task: keep firewall rules in sync with metagraph.

    Applies sysctl hardening once, then refreshes ufw rules every
    REFRESH_INTERVAL seconds. Skips gracefully if not running as root.
    """
    if not _is_root():
        log.info("firewall_skipped_not_root",
                 msg="Not running as root; firewall auto-management disabled. "
                     "Run as root or use scripts/miner-firewall.sh manually.")
        return

    if not _has_ufw():
        log.info("firewall_skipped_no_ufw",
                 msg="ufw not installed; firewall auto-management disabled. "
                     "Install with: apt-get install ufw")
        return

    # One-time sysctl hardening
    apply_sysctl_hardening()

    log.info("firewall_loop_started", api_port=api_port, refresh_s=REFRESH_INTERVAL)

    while True:
        try:
            validator_ips = _get_validator_ips(neuron)
            if validator_ips:
                update_firewall(validator_ips, api_port)
        except asyncio.CancelledError:
            return
        except Exception as e:
            log.warning("firewall_loop_error", error=str(e))

        await asyncio.sleep(REFRESH_INTERVAL)
