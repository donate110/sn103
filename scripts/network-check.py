#!/usr/bin/env python3
"""Djinn Protocol (SN103) Network Health Check.

Discovers all validators and miners from the metagraph via djinn.gg,
probes their health endpoints, checks for version mismatches, tests
attestation capacity, and produces a clear summary.

Usage:
    python3 scripts/network-check.py
    python3 scripts/network-check.py --timeout 10
    python3 scripts/network-check.py --json

Dependencies: requests (+ standard library)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any

import requests

# ---------------------------------------------------------------------------
# ANSI colours
# ---------------------------------------------------------------------------

class C:
    """ANSI colour codes, disabled when stdout is not a terminal."""
    _enabled = sys.stdout.isatty()

    @staticmethod
    def _wrap(code: str, text: str) -> str:
        if C._enabled:
            return f"\033[{code}m{text}\033[0m"
        return text

    @staticmethod
    def green(t: str) -> str:  return C._wrap("32", t)
    @staticmethod
    def yellow(t: str) -> str: return C._wrap("33", t)
    @staticmethod
    def red(t: str) -> str:    return C._wrap("31", t)
    @staticmethod
    def bold(t: str) -> str:   return C._wrap("1", t)
    @staticmethod
    def dim(t: str) -> str:    return C._wrap("2", t)
    @staticmethod
    def cyan(t: str) -> str:   return C._wrap("36", t)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DJINN_API_BASE = "https://djinn.gg/api"
DISCOVER_VALIDATORS_URL = f"{DJINN_API_BASE}/validators/discover"
DISCOVER_MINERS_URL = f"{DJINN_API_BASE}/miners/discover"
DEFAULT_TIMEOUT = 5  # seconds per request

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class NodeInfo:
    """Metagraph node from discovery."""
    uid: int
    ip: str
    port: int
    hotkey: str = ""
    stake: str = "0"
    role: str = "unknown"  # "validator" or "miner"


@dataclass
class HealthResult:
    """Result of probing a node's /health endpoint."""
    node: NodeInfo
    reachable: bool = False
    status: str = "unreachable"
    version: str = ""
    latency_ms: float = 0.0
    error: str = ""
    raw: dict = field(default_factory=dict)

    # Validator-specific
    chain_connected: bool | None = None
    bt_connected: bool | None = None
    shares_held: int | None = None
    pending_outcomes: int | None = None

    # Miner-specific
    odds_api_connected: bool | None = None
    uptime_seconds: float | None = None

    @property
    def health_grade(self) -> str:
        """Classify as healthy / degraded / down."""
        if not self.reachable:
            return "down"
        if self.status == "ok":
            return "healthy"
        if self.status == "degraded":
            return "degraded"
        return "degraded"


@dataclass
class AttestCapacityResult:
    """Result of probing /v1/attest/capacity."""
    node: NodeInfo
    reachable: bool = False
    inflight: int = 0
    max_capacity: int = 0
    available: int = 0
    error: str = ""


@dataclass
class NetworkReport:
    """Aggregated network health report."""
    validators: list[HealthResult] = field(default_factory=list)
    miners: list[HealthResult] = field(default_factory=list)
    attest_capacity: list[AttestCapacityResult] = field(default_factory=list)
    discovery_error: str = ""
    duration_s: float = 0.0
    issues: list[str] = field(default_factory=list)

# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def discover_nodes(timeout: int) -> tuple[list[NodeInfo], list[NodeInfo], str]:
    """Discover validators and miners from the djinn.gg API.

    Returns (validators, miners, error_string).
    """
    validators: list[NodeInfo] = []
    miners: list[NodeInfo] = []
    error = ""

    # Discover validators
    try:
        resp = requests.get(DISCOVER_VALIDATORS_URL, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        for v in data.get("validators", []):
            validators.append(NodeInfo(
                uid=v.get("uid", -1),
                ip=v.get("ip", ""),
                port=v.get("port", 0),
                hotkey=v.get("hotkey", ""),
                stake=v.get("stake", "0"),
                role="validator",
            ))
    except Exception as e:
        error += f"Validator discovery failed: {e}. "

    # Discover miners
    try:
        resp = requests.get(DISCOVER_MINERS_URL, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        for m in data.get("miners", []):
            miners.append(NodeInfo(
                uid=m.get("uid", -1),
                ip=m.get("ip", ""),
                port=m.get("port", 0),
                hotkey=m.get("hotkey", ""),
                stake=m.get("stake", "0"),
                role="miner",
            ))
    except Exception as e:
        error += f"Miner discovery failed: {e}. "

    return validators, miners, error.strip()

# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

def probe_health(node: NodeInfo, timeout: int) -> HealthResult:
    """Probe a single node's /health endpoint."""
    result = HealthResult(node=node)
    url = f"http://{node.ip}:{node.port}/health"

    start = time.monotonic()
    try:
        resp = requests.get(url, timeout=timeout)
        elapsed = (time.monotonic() - start) * 1000
        result.latency_ms = round(elapsed, 1)

        if resp.status_code != 200:
            result.error = f"HTTP {resp.status_code}"
            return result

        data = resp.json()
        result.reachable = True
        result.raw = data
        result.status = data.get("status", "unknown")
        result.version = data.get("version", "")
        result.bt_connected = data.get("bt_connected")

        if node.role == "validator":
            result.chain_connected = data.get("chain_connected")
            result.shares_held = data.get("shares_held")
            result.pending_outcomes = data.get("pending_outcomes")
        elif node.role == "miner":
            result.odds_api_connected = data.get("odds_api_connected")
            result.uptime_seconds = data.get("uptime_seconds")

    except requests.ConnectionError:
        result.error = "Connection refused"
    except requests.Timeout:
        result.error = "Timeout"
    except Exception as e:
        result.error = str(e)

    return result


def probe_attest_capacity(node: NodeInfo, timeout: int) -> AttestCapacityResult:
    """Probe a node's /v1/attest/capacity endpoint."""
    result = AttestCapacityResult(node=node)
    url = f"http://{node.ip}:{node.port}/v1/attest/capacity"

    try:
        resp = requests.get(url, timeout=timeout)
        if resp.status_code == 200:
            data = resp.json()
            result.reachable = True
            result.inflight = data.get("inflight", 0)
            result.max_capacity = data.get("max", 0)
            result.available = data.get("available", 0)
        else:
            result.error = f"HTTP {resp.status_code}"
    except Exception as e:
        result.error = str(e)

    return result

# ---------------------------------------------------------------------------
# Parallel probing
# ---------------------------------------------------------------------------

def probe_all(
    validators: list[NodeInfo],
    miners: list[NodeInfo],
    timeout: int,
) -> NetworkReport:
    """Probe all nodes in parallel."""
    report = NetworkReport()
    all_nodes = validators + miners

    if not all_nodes:
        return report

    # Probe health endpoints in parallel
    with ThreadPoolExecutor(max_workers=min(20, len(all_nodes))) as pool:
        # Health probes
        health_futures = {
            pool.submit(probe_health, node, timeout): node
            for node in all_nodes
        }
        # Attestation capacity probes (validators + miners both expose it)
        attest_futures = {
            pool.submit(probe_attest_capacity, node, timeout): node
            for node in all_nodes
        }

        for future in as_completed(health_futures):
            result = future.result()
            if result.node.role == "validator":
                report.validators.append(result)
            else:
                report.miners.append(result)

        for future in as_completed(attest_futures):
            result = future.result()
            if result.reachable:
                report.attest_capacity.append(result)

    # Sort by UID for consistent output
    report.validators.sort(key=lambda r: r.node.uid)
    report.miners.sort(key=lambda r: r.node.uid)
    report.attest_capacity.sort(key=lambda r: r.node.uid)

    return report

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze(report: NetworkReport) -> list[str]:
    """Analyze the report and produce a list of human-readable issues."""
    issues: list[str] = []

    # -- Discovery issues --
    if report.discovery_error:
        issues.append(f"Discovery: {report.discovery_error}")

    if not report.validators and not report.miners:
        issues.append("No nodes discovered at all -- metagraph may be empty or API unreachable")
        return issues

    # -- Reachability --
    down_validators = [r for r in report.validators if not r.reachable]
    down_miners = [r for r in report.miners if not r.reachable]

    if down_validators:
        uids = ", ".join(str(r.node.uid) for r in down_validators)
        issues.append(f"{len(down_validators)} validator(s) unreachable: UID {uids}")

    if down_miners:
        uids = ", ".join(str(r.node.uid) for r in down_miners)
        issues.append(f"{len(down_miners)} miner(s) unreachable: UID {uids}")

    # -- Degraded nodes --
    degraded_validators = [r for r in report.validators if r.health_grade == "degraded"]
    degraded_miners = [r for r in report.miners if r.health_grade == "degraded"]

    if degraded_validators:
        for r in degraded_validators:
            reasons = []
            if r.chain_connected is False:
                reasons.append("chain disconnected")
            if r.bt_connected is False:
                reasons.append("BT disconnected")
            reason_str = f" ({', '.join(reasons)})" if reasons else ""
            issues.append(f"Validator UID {r.node.uid} degraded{reason_str}")

    if degraded_miners:
        for r in degraded_miners:
            reasons = []
            if r.odds_api_connected is False:
                reasons.append("Odds API disconnected")
            if r.bt_connected is False:
                reasons.append("BT disconnected")
            reason_str = f" ({', '.join(reasons)})" if reasons else ""
            issues.append(f"Miner UID {r.node.uid} degraded{reason_str}")

    # -- Version mismatches --
    all_reachable = [r for r in report.validators + report.miners if r.reachable and r.version]
    if all_reachable:
        versions = set(r.version for r in all_reachable)
        if len(versions) > 1:
            version_groups: dict[str, list[str]] = {}
            for r in all_reachable:
                version_groups.setdefault(r.version, []).append(
                    f"{r.node.role[0].upper()}{r.node.uid}"
                )
            parts = [f"v{v}: {', '.join(nodes)}" for v, nodes in sorted(version_groups.items())]
            issues.append(f"Version mismatch across network: {' | '.join(parts)}")

    # -- Validator-specific checks --
    for r in report.validators:
        if r.reachable and r.chain_connected is False:
            issues.append(f"Validator UID {r.node.uid}: Base chain not connected")

    # -- Attestation capacity --
    for cap in report.attest_capacity:
        if cap.available == 0 and cap.max_capacity > 0:
            role_label = "Validator" if cap.node.role == "validator" else "Miner"
            issues.append(
                f"{role_label} UID {cap.node.uid}: attestation at capacity "
                f"({cap.inflight}/{cap.max_capacity} in-flight)"
            )

    # -- High latency --
    for r in report.validators + report.miners:
        if r.reachable and r.latency_ms > 2000:
            role = "Validator" if r.node.role == "validator" else "Miner"
            issues.append(f"{role} UID {r.node.uid}: high latency ({r.latency_ms:.0f}ms)")

    return issues

# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def _grade_icon(grade: str) -> str:
    if grade == "healthy":
        return C.green("[OK]")
    elif grade == "degraded":
        return C.yellow("[DEGRADED]")
    else:
        return C.red("[DOWN]")


def _bool_icon(val: bool | None) -> str:
    if val is True:
        return C.green("yes")
    elif val is False:
        return C.red("no")
    return C.dim("n/a")


def print_report(report: NetworkReport) -> None:
    """Print the full network health report to stdout."""
    print()
    print(C.bold("=" * 68))
    print(C.bold("  Djinn Protocol (SN103) -- Network Health Check"))
    print(C.bold("=" * 68))
    print()

    # -- Validators --
    print(C.bold(f"  VALIDATORS ({len(report.validators)} discovered)"))
    print(C.dim("  " + "-" * 64))

    if not report.validators:
        print(C.yellow("  No validators discovered"))
    else:
        for r in report.validators:
            icon = _grade_icon(r.health_grade)
            uid_str = f"UID {r.node.uid:>3}"
            addr = f"{r.node.ip}:{r.node.port}"

            print(f"  {icon} {uid_str}  {addr:<24}", end="")

            if r.reachable:
                ver = r.version or "?"
                print(f"  v{ver}  {r.latency_ms:>6.0f}ms", end="")
                parts = []
                parts.append(f"chain={_bool_icon(r.chain_connected)}")
                parts.append(f"bt={_bool_icon(r.bt_connected)}")
                if r.shares_held is not None:
                    parts.append(f"shares={r.shares_held}")
                if r.pending_outcomes is not None:
                    parts.append(f"pending={r.pending_outcomes}")
                print(f"  {' '.join(parts)}")
            else:
                print(f"  {C.red(r.error)}")

    print()

    # -- Miners --
    print(C.bold(f"  MINERS ({len(report.miners)} discovered)"))
    print(C.dim("  " + "-" * 64))

    if not report.miners:
        print(C.yellow("  No miners discovered"))
    else:
        for r in report.miners:
            icon = _grade_icon(r.health_grade)
            uid_str = f"UID {r.node.uid:>3}"
            addr = f"{r.node.ip}:{r.node.port}"

            print(f"  {icon} {uid_str}  {addr:<24}", end="")

            if r.reachable:
                ver = r.version or "?"
                print(f"  v{ver}  {r.latency_ms:>6.0f}ms", end="")
                parts = []
                parts.append(f"odds_api={_bool_icon(r.odds_api_connected)}")
                parts.append(f"bt={_bool_icon(r.bt_connected)}")
                if r.uptime_seconds is not None:
                    hrs = r.uptime_seconds / 3600
                    parts.append(f"up={hrs:.1f}h")
                print(f"  {' '.join(parts)}")
            else:
                print(f"  {C.red(r.error)}")

    print()

    # -- Attestation Capacity --
    if report.attest_capacity:
        print(C.bold(f"  ATTESTATION CAPACITY ({len(report.attest_capacity)} nodes responding)"))
        print(C.dim("  " + "-" * 64))

        for cap in report.attest_capacity:
            role = "V" if cap.node.role == "validator" else "M"
            uid_str = f"{role}{cap.node.uid:>3}"

            utilisation = 0.0
            if cap.max_capacity > 0:
                utilisation = (cap.inflight / cap.max_capacity) * 100

            if utilisation >= 90:
                bar_colour = C.red
            elif utilisation >= 50:
                bar_colour = C.yellow
            else:
                bar_colour = C.green

            bar_len = 20
            filled = int(bar_len * utilisation / 100)
            bar = bar_colour("*" * filled) + C.dim("." * (bar_len - filled))

            print(
                f"  {uid_str}  [{bar}]  "
                f"{cap.inflight}/{cap.max_capacity} in-flight  "
                f"({cap.available} available)"
            )
        print()

    # -- Version Summary --
    all_reachable = [r for r in report.validators + report.miners if r.reachable and r.version]
    if all_reachable:
        versions = set(r.version for r in all_reachable)
        print(C.bold("  VERSION SUMMARY"))
        print(C.dim("  " + "-" * 64))
        if len(versions) == 1:
            print(f"  {C.green('All nodes on same version:')} v{versions.pop()}")
        else:
            print(f"  {C.yellow('Version mismatch detected:')}")
            version_groups: dict[str, list[str]] = {}
            for r in all_reachable:
                label = f"{'V' if r.node.role == 'validator' else 'M'}{r.node.uid}"
                version_groups.setdefault(r.version, []).append(label)
            for v, nodes in sorted(version_groups.items()):
                print(f"    v{v}: {', '.join(nodes)}")
        print()

    # -- Issues / Summary --
    issues = analyze(report)
    report.issues = issues

    print(C.bold("  SUMMARY"))
    print(C.dim("  " + "-" * 64))

    total_nodes = len(report.validators) + len(report.miners)
    healthy = sum(
        1 for r in report.validators + report.miners if r.health_grade == "healthy"
    )
    degraded = sum(
        1 for r in report.validators + report.miners if r.health_grade == "degraded"
    )
    down = sum(
        1 for r in report.validators + report.miners if r.health_grade == "down"
    )

    print(
        f"  Nodes: {total_nodes} total  "
        f"{C.green(f'{healthy} healthy')}  "
        f"{C.yellow(f'{degraded} degraded') if degraded else f'{degraded} degraded'}  "
        f"{C.red(f'{down} down') if down else f'{down} down'}"
    )
    print(f"  Scan completed in {report.duration_s:.1f}s")
    print()

    if issues:
        print(f"  {C.red(C.bold(f'Issues found ({len(issues)}):'))}")
        for issue in issues:
            print(f"    {C.red('*')} {issue}")
    else:
        print(f"  {C.green(C.bold('Network OK -- no issues detected'))}")

    print()
    print(C.bold("=" * 68))
    print()


def to_json(report: NetworkReport) -> dict[str, Any]:
    """Serialize the report to a JSON-compatible dict."""
    def _health(r: HealthResult) -> dict:
        d: dict[str, Any] = {
            "uid": r.node.uid,
            "ip": r.node.ip,
            "port": r.node.port,
            "role": r.node.role,
            "reachable": r.reachable,
            "status": r.status,
            "version": r.version,
            "latency_ms": r.latency_ms,
            "health_grade": r.health_grade,
        }
        if r.error:
            d["error"] = r.error
        if r.node.role == "validator":
            d["chain_connected"] = r.chain_connected
            d["bt_connected"] = r.bt_connected
            d["shares_held"] = r.shares_held
            d["pending_outcomes"] = r.pending_outcomes
        elif r.node.role == "miner":
            d["odds_api_connected"] = r.odds_api_connected
            d["bt_connected"] = r.bt_connected
            d["uptime_seconds"] = r.uptime_seconds
        return d

    def _attest(c: AttestCapacityResult) -> dict:
        return {
            "uid": c.node.uid,
            "role": c.node.role,
            "inflight": c.inflight,
            "max_capacity": c.max_capacity,
            "available": c.available,
        }

    all_results = report.validators + report.miners
    return {
        "timestamp": time.time(),
        "duration_s": report.duration_s,
        "discovery_error": report.discovery_error or None,
        "validators": [_health(r) for r in report.validators],
        "miners": [_health(r) for r in report.miners],
        "attestation_capacity": [_attest(c) for c in report.attest_capacity],
        "summary": {
            "total_nodes": len(all_results),
            "healthy": sum(1 for r in all_results if r.health_grade == "healthy"),
            "degraded": sum(1 for r in all_results if r.health_grade == "degraded"),
            "down": sum(1 for r in all_results if r.health_grade == "down"),
        },
        "issues": report.issues,
        "ok": len(report.issues) == 0,
    }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Djinn Protocol (SN103) Network Health Check",
    )
    parser.add_argument(
        "--timeout", type=int, default=DEFAULT_TIMEOUT,
        help=f"Timeout per request in seconds (default: {DEFAULT_TIMEOUT})",
    )
    parser.add_argument(
        "--json", action="store_true", dest="json_output",
        help="Output results as JSON instead of formatted text",
    )
    parser.add_argument(
        "--validators-only", action="store_true",
        help="Only check validators",
    )
    parser.add_argument(
        "--miners-only", action="store_true",
        help="Only check miners",
    )
    args = parser.parse_args()

    start = time.monotonic()

    # Step 1: Discover nodes
    if not args.json_output:
        print()
        print(C.dim("  Discovering nodes from djinn.gg metagraph API..."))

    validators, miners, discovery_error = discover_nodes(args.timeout)

    if args.validators_only:
        miners = []
    if args.miners_only:
        validators = []

    if not args.json_output:
        print(
            C.dim(f"  Found {len(validators)} validator(s), {len(miners)} miner(s)")
        )
        if discovery_error:
            print(C.yellow(f"  Warning: {discovery_error}"))
        print(C.dim("  Probing health endpoints..."))

    # Step 2: Probe all nodes
    report = probe_all(validators, miners, args.timeout)
    report.discovery_error = discovery_error
    report.duration_s = round(time.monotonic() - start, 1)

    # Step 3: Analyze
    report.issues = analyze(report)

    # Step 4: Output
    if args.json_output:
        print(json.dumps(to_json(report), indent=2))
    else:
        print_report(report)

    # Exit code: 0 if no issues, 1 if issues found
    return 0 if not report.issues else 1


if __name__ == "__main__":
    sys.exit(main())
