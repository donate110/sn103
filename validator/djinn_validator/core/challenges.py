"""Miner challenge system — cross-miner consensus scoring.

Each epoch, the validator:
1. Picks an active sport and fetches live games from ESPN (free, no API key)
2. Constructs a challenge from real games + synthetic lines
3. Sends the SAME challenge to ALL miners concurrently (Phase 1: Query)
4. Computes per-line consensus from all responses (Phase 2: Consensus)
5. Scores each miner against consensus + synthetic ground truth (Phase 3: Score)
6. Requests TLSNotary proofs from outliers + random sample (Phase 4: Proof)

Miners ARE the oracle — the validator has no ground truth for real lines.
Cross-miner consensus determines correctness; synthetic lines (fake event
IDs) provide absolute ground truth. TLSNotary proofs target outliers.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import httpx
import structlog

from djinn_validator.core.scoring import MinerScorer

if TYPE_CHECKING:
    from djinn_validator.core.espn import ESPNClient, ESPNGame

# Max concurrent miner queries to avoid overwhelming the network
_MAX_CONCURRENT_CHALLENGES = 16

# Minimum miners needed for consensus to be meaningful
MIN_MINERS_FOR_CONSENSUS = 3

# Probability that an epoch requires ALL miners to submit TLSNotary proof
FULL_PROOF_EPOCH_PROBABILITY = 0.20

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Peer Notary Discovery
# ---------------------------------------------------------------------------


@dataclass
class PeerNotary:
    """A miner that can serve as a peer notary for other miners."""

    uid: int
    ip: str
    port: int  # miner API port
    notary_port: int  # TCP port of the notary sidecar
    pubkey_hex: str


async def _ws_handshake_ok(ip: str, port: int, timeout: float = 5.0) -> bool:
    """Verify a WebSocket endpoint accepts connections (HTTP 101 upgrade).

    Sends a minimal WebSocket upgrade request and checks for 101 status.
    This catches miners whose HTTP /v1/notary/info returns 200 but whose
    actual WebSocket sidecar at /v1/notary/ws is dead (returns 403 or hangs).
    """
    import base64
    import os

    ws_key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /v1/notary/ws HTTP/1.1\r\n"
        f"Host: {ip}:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {ws_key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    )
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port),
            timeout=timeout,
        )
        writer.write(request.encode())
        await writer.drain()
        # Read just enough of the response to check the status line
        response_line = await asyncio.wait_for(
            reader.readline(),
            timeout=timeout,
        )
        writer.close()
        await writer.wait_closed()
        # Expect "HTTP/1.1 101 Switching Protocols\r\n"
        return b"101" in response_line
    except Exception:
        return False


async def discover_peer_notaries(
    client: httpx.AsyncClient,
    axons: list[dict],
    concurrency: int = 20,
) -> list[PeerNotary]:
    """Discover miners running notary sidecars via /v1/notary/info.

    After HTTP metadata check passes, performs a WebSocket handshake probe
    on the notary port to verify the sidecar actually accepts connections.
    Miners whose HTTP endpoint returns 200 but whose WebSocket is broken
    (403, timeout, connection refused) are excluded.

    Old miners without the endpoint return 404/405 and are silently skipped.
    This ensures full backwards compatibility.
    """
    sem = asyncio.Semaphore(concurrency)
    notaries: list[PeerNotary] = []

    async def _probe(axon: dict) -> None:
        ip = axon.get("ip", "")
        port = axon.get("port", 0)
        uid = axon.get("uid", -1)
        if not ip or not port:
            return
        url = f"http://{ip}:{port}/v1/notary/info"
        async with sem:
            try:
                resp = await client.get(url, timeout=5.0)
                if resp.status_code != 200:
                    return
                data = resp.json()
                if not (data.get("enabled") and data.get("pubkey_hex")):
                    return
                notary_port = data["port"]

                # WebSocket pre-flight: verify the sidecar accepts WS connections
                if not await _ws_handshake_ok(ip, notary_port):
                    log.warning(
                        "notary_ws_probe_failed",
                        uid=uid,
                        ip=ip,
                        notary_port=notary_port,
                        msg="HTTP info OK but WebSocket handshake failed, excluding",
                    )
                    return

                notaries.append(PeerNotary(
                    uid=uid,
                    ip=ip,
                    port=port,
                    notary_port=notary_port,
                    pubkey_hex=data["pubkey_hex"],
                ))
            except (httpx.HTTPError, Exception):
                pass

    await asyncio.gather(*[_probe(a) for a in axons])
    return notaries


def assign_peer_notary(
    prover_uid: int,
    notaries: list[PeerNotary],
    prover_ip: str | None = None,
    assignment_counts: dict[int, int] | None = None,
    max_per_notary: int = 4,
    exclude_uids: set[int] | None = None,
) -> PeerNotary | None:
    """Randomly assign a peer notary for a prover miner.

    Excludes the prover itself and any notary on the same IP address
    (same operator running multiple miners on one machine could collude).

    Args:
        assignment_counts: Track how many times each notary UID has been
            assigned in the current round. Mutated in-place on assignment.
            When None, no load-balancing cap is applied.
        max_per_notary: Maximum assignments per notary per round.
        exclude_uids: Notary UIDs to exclude (e.g. previously failed notaries).

    Returns None if no eligible notary is available.
    """
    eligible = [n for n in notaries if n.uid != prover_uid]
    if prover_ip:
        eligible = [n for n in eligible if n.ip != prover_ip]
    if exclude_uids:
        eligible = [n for n in eligible if n.uid not in exclude_uids]
    if assignment_counts is not None:
        eligible = [n for n in eligible if assignment_counts.get(n.uid, 0) < max_per_notary]
    if not eligible:
        return None
    chosen = random.choice(eligible)
    if assignment_counts is not None:
        assignment_counts[chosen.uid] = assignment_counts.get(chosen.uid, 0) + 1
    return chosen


# ---------------------------------------------------------------------------
# Data classes for the 4-phase challenge flow
# ---------------------------------------------------------------------------


@dataclass
class MinerResponse:
    """Raw response from one miner during Phase 1 (Query)."""

    uid: int
    hotkey: str
    ip: str
    port: int
    available_indices: set[int] = field(default_factory=set)
    query_id: str | None = None
    latency: float = 0.0
    success: bool = False
    error: str | None = None


@dataclass
class LineConsensus:
    """Consensus result for a single challenge line."""

    index: int
    is_synthetic: bool
    votes_available: int = 0
    votes_unavailable: int = 0
    total_voters: int = 0

    @property
    def consensus_available(self) -> bool:
        """Majority says this line is available."""
        return self.votes_available > self.votes_unavailable

    @property
    def confidence(self) -> float:
        """Fraction of voters that agree with the majority."""
        if self.total_voters == 0:
            return 0.0
        majority = max(self.votes_available, self.votes_unavailable)
        return majority / self.total_voters

    @property
    def is_strong(self) -> bool:
        """Strong consensus: >= 70% agreement."""
        return self.confidence >= 0.70

    @property
    def is_tie(self) -> bool:
        """Exactly split vote."""
        return self.votes_available == self.votes_unavailable


@dataclass
class ConsensusResult:
    """Consensus across all challenge lines from all responding miners."""

    line_consensuses: dict[int, LineConsensus] = field(default_factory=dict)
    responding_miners: int = 0
    total_miners: int = 0

    @property
    def has_quorum(self) -> bool:
        """Enough miners responded to compute meaningful consensus."""
        return self.responding_miners >= MIN_MINERS_FOR_CONSENSUS

# Sports we challenge on (must be in ESPN's supported set)
CHALLENGE_SPORTS = [
    "basketball_nba",
    "americanfootball_nfl",
    "baseball_mlb",
    "icehockey_nhl",
]

# Limit challenges per epoch to conserve resources
MAX_CHALLENGES_PER_EPOCH = 1


def build_challenge_lines(games: list[ESPNGame], sport: str) -> list[dict]:
    """Build a set of 10 candidate lines from live ESPN games.

    Uses real game teams to construct plausible challenge lines. The validator
    doesn't know if these lines are actually available — that's the miner's
    job. We include synthetic lines with fake event IDs that shouldn't be
    available at any sportsbook.
    """
    if not games:
        return []

    real_lines: list[dict] = []

    for game in games:
        if not game.home_team or not game.away_team:
            continue
        # Generate plausible lines for each game
        event_id = f"espn_{game.espn_id}"
        for market, side, line_val in _generate_plausible_lines(game):
            real_lines.append({
                "sport": sport,
                "event_id": event_id,
                "home_team": game.home_team,
                "away_team": game.away_team,
                "market": market,
                "line": line_val,
                "side": side,
            })

    if not real_lines:
        return []

    # Select up to 5 real lines (lower ratio to increase synthetic coverage)
    real_count = min(5, len(real_lines))
    selected = random.sample(real_lines, real_count)

    # Create synthetic unavailable lines — diversified to resist pattern matching
    synthetic_count = min(10 - real_count, 5)
    _synthetic_types = ["extreme_line", "fake_event", "wrong_market"]
    for i in range(synthetic_count):
        base = random.choice(real_lines)
        synth_type = _synthetic_types[i % len(_synthetic_types)]
        synth_line = base.get("line") or 0
        synth_market = base["market"]

        if synth_type == "extreme_line":
            synth_line += random.uniform(500, 2000)
        elif synth_type == "fake_event":
            pass  # line stays plausible but event_id is fake
        else:  # wrong_market
            synth_market = "player_prop"

        selected.append({
            "sport": sport,
            "event_id": hashlib.sha256(
                f"{base['event_id']}:synthetic:{i}:{random.random()}".encode()
            ).hexdigest()[:24],
            "home_team": base["home_team"],
            "away_team": base["away_team"],
            "market": synth_market,
            "line": synth_line,
            "side": base["side"],
            "is_synthetic": True,
        })

    # Shuffle and assign indices 1-10
    random.shuffle(selected)
    for i, line in enumerate(selected):
        line["index"] = i + 1

    return selected[:10]


def _generate_plausible_lines(game: ESPNGame) -> list[tuple[str, str, float | None]]:
    """Generate plausible betting lines for a game.

    Returns (market, side, line_value) tuples.
    """
    lines: list[tuple[str, str, float | None]] = []

    # Spread lines
    for spread in (-3.5, -7.5, 3.5, 7.5):
        team = game.home_team if spread < 0 else game.away_team
        lines.append(("spreads", team, spread))

    # Total lines
    for total in (210.5, 220.5, 230.5):
        lines.append(("totals", "Over", total))
        lines.append(("totals", "Under", total))

    # Moneyline
    lines.append(("h2h", game.home_team, None))
    lines.append(("h2h", game.away_team, None))

    return lines


def _sign_miner_request(
    endpoint: str,
    body: bytes,
    wallet: Any | None,
) -> dict[str, str]:
    """Create signed auth headers for an outbound request to a miner.

    Returns empty dict if wallet is unavailable (dev mode).
    """
    if wallet is None:
        return {}
    try:
        from djinn_validator.api.middleware import create_signed_headers
        return create_signed_headers(endpoint, body, wallet)
    except Exception as e:
        log.warning("sign_miner_request_failed", error=str(e))
        return {}


async def _query_one(
    client: httpx.AsyncClient,
    axon: dict,
    check_payload: dict,
    sem: asyncio.Semaphore,
    wallet: Any | None = None,
) -> MinerResponse | None:
    """Phase 1: Send the challenge to one miner and collect raw response.

    Returns None if the miner has no IP (skip), otherwise returns MinerResponse.
    """
    uid = axon["uid"]
    hotkey = axon["hotkey"]
    ip = axon.get("ip", "")
    port = axon.get("port", 0)

    if not ip or not port:
        return None

    resp = MinerResponse(uid=uid, hotkey=hotkey, ip=ip, port=port)
    check_url = f"http://{ip}:{port}/v1/check"

    async with sem:
        start = time.perf_counter()
        try:
            body = json.dumps(check_payload).encode()
            auth_headers = _sign_miner_request("/v1/check", body, wallet)
            http_resp = await client.post(
                check_url, content=body,
                headers={"Content-Type": "application/json", **auth_headers},
                timeout=10.0,
            )
            resp.latency = time.perf_counter() - start

            if http_resp.status_code != 200:
                resp.error = f"HTTP {http_resp.status_code}"
                return resp

            data = http_resp.json()
            raw_indices = data.get("available_indices", [])
            resp.available_indices = {int(i) for i in raw_indices if isinstance(i, (int, float, str))}
            resp.query_id = data.get("query_id")
            resp.success = True
            return resp

        except Exception as e:
            resp.latency = time.perf_counter() - start
            resp.error = str(e)[:200]
            return resp


def _compute_consensus(
    responses: list[MinerResponse],
    challenge_lines: list[dict],
    synthetic_indices: set[int],
) -> ConsensusResult:
    """Phase 2: Compute per-line consensus from all successful miner responses."""
    successful = [r for r in responses if r.success]
    all_indices = {line["index"] for line in challenge_lines}

    result = ConsensusResult(
        responding_miners=len(successful),
        total_miners=len(responses),
    )

    for idx in all_indices:
        lc = LineConsensus(index=idx, is_synthetic=idx in synthetic_indices)
        for r in successful:
            if idx in r.available_indices:
                lc.votes_available += 1
            else:
                lc.votes_unavailable += 1
            lc.total_voters += 1
        result.line_consensuses[idx] = lc

    return result


def _score_against_consensus(
    response: MinerResponse,
    consensus: ConsensusResult,
    synthetic_indices: set[int],
    all_line_indices: set[int],
) -> tuple[bool, float]:
    """Phase 3: Score one miner's response against consensus.

    Returns (is_correct, accuracy_score) where:
    - Synthetic lines: ground truth always "unavailable" (no consensus needed)
    - Real lines with strong consensus (>=70%): match = full credit, mismatch = 0
    - Real lines with weak consensus (50-70%): match = 0.8, mismatch = 0.3
    - Real lines with tie: 0.5 neutral credit
    - Below quorum (<3 miners): only synthetic lines are scored

    is_correct = weighted accuracy >= 0.6
    """
    if not response.success:
        return False, 0.0

    total_credit = 0.0
    total_lines = 0

    for idx in all_line_indices:
        lc = consensus.line_consensuses.get(idx)
        if lc is None:
            continue

        miner_says_available = idx in response.available_indices

        if idx in synthetic_indices:
            # Synthetic: ground truth is always unavailable
            total_credit += 0.0 if miner_says_available else 1.0
            total_lines += 1
        elif consensus.has_quorum:
            # Real line with quorum: score against consensus
            if lc.is_tie:
                total_credit += 0.5
            elif lc.is_strong:
                agrees = miner_says_available == lc.consensus_available
                total_credit += 1.0 if agrees else 0.0
            else:
                # Weak consensus (50-70%)
                agrees = miner_says_available == lc.consensus_available
                total_credit += 0.8 if agrees else 0.3
            total_lines += 1
        # else: below quorum, skip real lines (only synthetics scored)

    accuracy = total_credit / total_lines if total_lines > 0 else 0.0
    is_correct = accuracy >= 0.6
    return is_correct, accuracy


def _select_proof_targets(
    responses: list[MinerResponse],
    consensus: ConsensusResult,
    synthetic_indices: set[int],
    max_proofs: int = 4,
) -> list[MinerResponse]:
    """Phase 4: Select miners to request TLSNotary proofs from.

    Priority:
    1. Outliers — disagree with strong consensus on 2+ lines
    2. Fill remaining slots with random miners that have query_ids
    """
    if not consensus.has_quorum:
        # No meaningful consensus — just pick random miners with query_ids
        with_qid = [r for r in responses if r.success and r.query_id]
        return random.sample(with_qid, min(max_proofs, len(with_qid)))

    # Find outliers: miners who disagree with strong consensus on 2+ lines
    outliers: list[MinerResponse] = []
    non_outliers_with_qid: list[MinerResponse] = []

    for r in responses:
        if not r.success or not r.query_id:
            continue

        disagreements = 0
        for idx, lc in consensus.line_consensuses.items():
            if idx in synthetic_indices or not lc.is_strong:
                continue
            miner_says = idx in r.available_indices
            if miner_says != lc.consensus_available:
                disagreements += 1

        if disagreements >= 2:
            outliers.append(r)
        else:
            non_outliers_with_qid.append(r)

    # Outliers first, then fill with random
    targets = outliers[:max_proofs]
    remaining = max_proofs - len(targets)
    if remaining > 0 and non_outliers_with_qid:
        targets += random.sample(
            non_outliers_with_qid,
            min(remaining, len(non_outliers_with_qid)),
        )

    return targets


@dataclass
class ChallengeResult:
    """Rich result from a challenge round for activity logging."""

    challenged: int = 0
    sport: str = ""
    games_found: int = 0
    lines_used: int = 0
    responding: int = 0
    consensus_quorum: bool = False
    proofs_requested: int = 0
    proofs_submitted: int = 0
    miner_results: list[dict] = field(default_factory=list)
    challenge_lines: list[dict] = field(default_factory=list)


@dataclass
class AttestationResult:
    """Rich result from an attestation challenge for activity logging."""

    challenged: int = 0
    verified: int = 0
    url: str = ""
    reachable: int = 0
    capable: int = 0
    miner_results: list[dict] = field(default_factory=list)


async def challenge_miners(
    scorer: MinerScorer,
    miner_axons: list[dict],
    espn_client: ESPNClient | None = None,
    wallet: Any | None = None,
) -> ChallengeResult:
    """Run a consensus-based scoring challenge against all reachable miners.

    4-phase flow:
    1. Query all miners concurrently with the same challenge
    2. Compute per-line consensus from all responses
    3. Score each miner against consensus + synthetic ground truth
    4. Request TLSNotary proofs from outliers + random sample

    Returns a ChallengeResult with per-miner details.
    """
    result = ChallengeResult()

    if espn_client is None:
        from djinn_validator.core.espn import ESPNClient
        espn_client = ESPNClient()

    # Pick a random sport
    sport = random.choice(CHALLENGE_SPORTS)
    result.sport = sport

    # Fetch live games from ESPN
    games = await espn_client.get_scoreboard(sport)
    if not games:
        log.debug("no_challenge_games", sport=sport)
        return result

    # Filter to in-progress or scheduled games
    active_games = [g for g in games if g.status in ("in_progress", "scheduled", "pending")]
    if not active_games:
        active_games = games  # Fall back to all games if none are active

    result.games_found = len(active_games)
    challenge_lines = build_challenge_lines(active_games, sport)
    result.lines_used = len(challenge_lines)
    result.challenge_lines = [
        {
            "index": line["index"],
            "sport": line["sport"],
            "event_id": line["event_id"],
            "home_team": line["home_team"],
            "away_team": line["away_team"],
            "market": line["market"],
            "line": line.get("line"),
            "side": line["side"],
            "is_synthetic": line.get("is_synthetic", False),
        }
        for line in challenge_lines
    ]
    if len(challenge_lines) < 3:
        log.debug("insufficient_challenge_lines", sport=sport, count=len(challenge_lines))
        return result

    # Build the check request payload (matching miner's CheckRequest model)
    check_payload = {
        "lines": [
            {
                "index": line["index"],
                "sport": line["sport"],
                "event_id": line["event_id"],
                "home_team": line["home_team"],
                "away_team": line["away_team"],
                "market": line["market"],
                "line": line.get("line"),
                "side": line["side"],
            }
            for line in challenge_lines
        ]
    }

    # Track which lines are synthetic (should be unavailable)
    synthetic_indices = {
        line["index"] for line in challenge_lines if line.get("is_synthetic")
    }
    all_line_indices = {line["index"] for line in challenge_lines}

    sem = asyncio.Semaphore(_MAX_CONCURRENT_CHALLENGES)

    async with httpx.AsyncClient() as client:
        # ── Phase 1: Query all miners concurrently ──
        raw_results = await asyncio.gather(
            *[_query_one(client, axon, check_payload, sem, wallet=wallet) for axon in miner_axons]
        )
        responses = [r for r in raw_results if r is not None]

        if not responses:
            return result

        # ── Phase 2: Compute consensus ──
        consensus = _compute_consensus(responses, challenge_lines, synthetic_indices)
        result.responding = consensus.responding_miners
        result.consensus_quorum = consensus.has_quorum

        # ── Phase 3: Score each miner against consensus ──
        for r in responses:
            metrics = scorer.get_or_create(r.uid, r.hotkey)
            mr: dict = {"uid": r.uid, "latency": round(r.latency, 3)}
            if not r.success:
                metrics.record_query(correct=False, latency=r.latency, proof_submitted=False)
                mr["error"] = r.error or "no response"
                mr["correct"] = False
                log.debug("challenge_miner_error", uid=r.uid, err=r.error)
                result.miner_results.append(mr)
                continue

            is_correct, accuracy = _score_against_consensus(
                r, consensus, synthetic_indices, all_line_indices,
            )
            metrics.record_query(
                correct=is_correct,
                latency=r.latency,
                proof_submitted=False,  # Updated in Phase 4 if proof requested
            )
            mr["correct"] = is_correct
            mr["accuracy"] = round(accuracy, 2)
            mr["available"] = len(r.available_indices)
            result.miner_results.append(mr)
            log.info(
                "challenge_miner_scored", uid=r.uid,
                accuracy=round(accuracy, 2),
                is_correct=is_correct,
                available_count=len(r.available_indices),
                consensus_quorum=consensus.has_quorum,
                latency_s=round(r.latency, 3),
                query_id=r.query_id or "none",
            )

        # ── Phase 4: Request proofs from targeted miners ──
        # Spot-check: 20% of epochs require ALL miners to submit proof
        is_full_proof_epoch = random.random() < FULL_PROOF_EPOCH_PROBABILITY
        if is_full_proof_epoch:
            proof_targets = [r for r in responses if r.success and r.query_id]
            log.info("full_proof_epoch", target_count=len(proof_targets))
        else:
            proof_targets = _select_proof_targets(
                responses, consensus, synthetic_indices,
            )
        result.proofs_requested = len(proof_targets)
        for target in proof_targets:
            # Track that this miner was requested for proof
            metrics = scorer.get_or_create(target.uid, target.hotkey)
            metrics.proofs_requested += 1

            proof_submitted, proof_valid = await _request_and_verify_proof(
                client, target.ip, target.port, target.query_id, target.uid,
                wallet=wallet,
            )
            if proof_submitted:
                metrics.proofs_submitted += 1
                result.proofs_submitted += 1
                log.info(
                    "challenge_proof_result", uid=target.uid,
                    proof_submitted=proof_submitted,
                    proof_valid=proof_valid,
                )
            # Annotate the miner result with proof info
            for mr in result.miner_results:
                if mr["uid"] == target.uid:
                    mr["proof_requested"] = True
                    mr["proof_submitted"] = proof_submitted
                    mr["proof_valid"] = proof_valid
                    break

    result.challenged = len(responses)
    if result.challenged:
        log.info(
            "challenge_round_complete", sport=sport,
            miners_challenged=result.challenged,
            consensus_quorum=consensus.has_quorum,
            responding=consensus.responding_miners,
        )
    return result


async def _request_and_verify_proof(
    client: httpx.AsyncClient,
    ip: str,
    port: int,
    query_id: str,
    uid: int,
    wallet: Any | None = None,
) -> tuple[bool, bool]:
    """Request a TLSNotary proof from the miner and verify it.

    Returns (proof_submitted, proof_valid).
    """
    proof_url = f"http://{ip}:{port}/v1/proof"
    try:
        body = json.dumps({"query_id": query_id}).encode()
        auth_headers = _sign_miner_request("/v1/proof", body, wallet)
        proof_resp = await client.post(
            proof_url,
            content=body,
            headers={"Content-Type": "application/json", **auth_headers},
            timeout=30.0,
        )
        if proof_resp.status_code != 200:
            log.debug("proof_request_error", uid=uid, status=proof_resp.status_code)
            return False, False

        proof_data = proof_resp.json()
        if proof_data.get("status") not in ("submitted", "verified"):
            return False, False

        # Extract and verify the TLSNotary presentation bytes if present
        proof_bytes = None
        message = proof_data.get("message", "")
        if message:
            try:
                meta = json.loads(message)
                if meta.get("type") == "tlsnotary" and meta.get("presentation"):
                    import base64
                    proof_bytes = base64.b64decode(meta["presentation"])
            except (json.JSONDecodeError, ValueError, Exception) as e:
                # Miner sent a message but it's malformed — reject the proof entirely.
                # This prevents miners from gaming the system by submitting garbage
                # metadata to get "submitted but unverified" credit.
                log.warning("malformed_proof_metadata", uid=uid, err=str(e))
                return False, False

        if proof_bytes is None:
            # No TLSNotary presentation — proof submitted but not verifiable
            return True, False

        try:
            from djinn_validator.core import tlsn as tlsn_verifier
            if not tlsn_verifier.is_available():
                log.debug("tlsn_verifier_unavailable", uid=uid)
                return True, False
            verify_result = await asyncio.wait_for(
                tlsn_verifier.verify_proof(proof_bytes),
                timeout=30.0,
            )
            if not verify_result.verified:
                log.debug("proof_verification_failed", uid=uid, error=verify_result.error)
            return True, verify_result.verified
        except ImportError:
            log.debug("tlsn_verifier_not_installed", uid=uid)
            return True, False
        except TimeoutError:
            log.debug("proof_verification_timeout", uid=uid)
            return True, False
        except Exception as e:
            log.debug("proof_verification_error", uid=uid, err=str(e))
            return True, False

    except httpx.HTTPError as e:
        log.debug("proof_request_unreachable", uid=uid, err=str(e))
        return False, False
    except Exception as e:
        log.debug("proof_request_error", uid=uid, err=str(e))
        return False, False


# Known-good HTTPS URLs for attestation challenges. The validator
# fetches these itself to confirm the miner's proof is for the correct server.
_ATTESTATION_CHALLENGE_URLS = [
    "https://www.example.com/",
    "https://httpbin.org/get",
    "https://api.github.com/zen",
]


async def _probe_attest_capability(
    client: httpx.AsyncClient,
    axons: list[dict],
    concurrency: int = 20,
) -> list[dict]:
    """Fast probe to find miners that have /v1/attest endpoint.

    POSTs an empty body — miners with the endpoint return 422 (validation
    error) instantly, miners without it return 404 or timeout.
    Returns the list of axons that responded with 422.
    """
    sem = asyncio.Semaphore(concurrency)
    capable: list[dict] = []

    async def _probe(axon: dict) -> None:
        url = f"http://{axon['ip']}:{axon['port']}/v1/attest"
        async with sem:
            try:
                resp = await client.post(
                    url, content=b"{}", headers={"Content-Type": "application/json"},
                    timeout=5.0,
                )
                if resp.status_code == 422:
                    capable.append(axon)
            except httpx.HTTPError:
                pass

    await asyncio.gather(*[_probe(a) for a in axons])
    return capable


async def challenge_miners_attestation(
    scorer: MinerScorer,
    miner_axons: list[dict],
    wallet: Any | None = None,
) -> AttestationResult:
    """Run a TLSNotary attestation challenge against capable miners.

    Three phases:
    1. Fast probe (5s): POST empty body to all miners to find which ones
       have /v1/attest (422 = has it, 404/timeout = doesn't)
    1b. Notary discovery: GET /v1/notary/info from all miners to find peer
        notaries. Old miners without the endpoint are silently skipped.
    2. Full challenge (210s): send real attestation to capable miners,
       assigning a random peer notary where available.

    Returns an AttestationResult with per-miner details.
    """
    ar = AttestationResult()
    url = random.choice(_ATTESTATION_CHALLENGE_URLS)
    ar.url = url

    reachable = [a for a in miner_axons if a.get("ip") and a.get("port")]
    ar.reachable = len(reachable)

    async with httpx.AsyncClient() as client:
        # Phase 1: fast probe all miners (~15s for 246 miners at concurrency 20)
        # Run capability probe and notary discovery in parallel
        capable_task = asyncio.create_task(
            _probe_attest_capability(client, reachable)
        )
        notary_task = asyncio.create_task(
            discover_peer_notaries(client, reachable)
        )
        capable = await capable_task
        peer_notaries = await notary_task

        ar.capable = len(capable)

        # Mark miners as notary-capable if their IP hosts a notary sidecar.
        # Multiple miners on the same server share the sidecar, so all
        # miners on a notary IP are considered capable.
        notary_ips = {n.ip for n in peer_notaries}
        notary_capable_count = 0
        for axon in reachable:
            uid = axon.get("uid")
            hotkey = axon.get("hotkey", "")
            if uid is not None and hotkey:
                m = scorer.get_or_create(uid, hotkey)
                if axon.get("ip") in notary_ips:
                    m.notary_capable = True
                    notary_capable_count += 1

        log.info(
            "attest_probe_complete",
            total=len(reachable),
            capable=len(capable),
            peer_notaries=len(peer_notaries),
            notary_capable_miners=notary_capable_count,
        )

        if not capable:
            return ar

        # Phase 2: full challenge only capable miners
        # Load-balance notary assignments: cap concurrent provers per notary.
        # With sem=4, a notary handles at most 4 MPC sessions at once; we cap
        # total assignments per notary so each one isn't overwhelmed across
        # the full round.  max_per_notary scales with the notary pool size.
        _notary_counts: dict[int, int] = {}
        _max_per_notary = max(4, len(capable) // max(len(peer_notaries), 1))
        sem = asyncio.Semaphore(4)
        per_miner: list[dict] = []

        async def _challenge_one(axon: dict) -> tuple[bool, bool]:
            """Returns (attempted, proof_valid)."""
            uid = axon["uid"]
            hotkey = axon["hotkey"]
            metrics = scorer.get_or_create(uid, hotkey)
            miner_url = f"http://{axon['ip']}:{axon['port']}/v1/attest"
            request_id = f"challenge-{uid}-{int(time.time())}"
            mr: dict = {"uid": uid}

            # Assign a peer notary if available (backwards-compat: omit fields
            # for old miners that don't understand notary_host/notary_port)
            assigned_notary = assign_peer_notary(
                uid, peer_notaries, prover_ip=axon.get("ip"),
                assignment_counts=_notary_counts, max_per_notary=_max_per_notary,
            )

            async with sem:
                start = time.perf_counter()
                try:
                    payload: dict[str, Any] = {"url": url, "request_id": request_id}
                    if assigned_notary:
                        # Use WebSocket proxy on the peer miner's existing API port.
                        # The prover connects to ws://<ip>:<api_port>/v1/notary/ws
                        # which proxies to the notary sidecar on localhost:7047.
                        payload["notary_host"] = assigned_notary.ip
                        payload["notary_port"] = assigned_notary.port  # API port, not TCP notary port
                        payload["notary_ws"] = True  # signal to use WebSocket transport
                        mr["notary_uid"] = assigned_notary.uid
                        mr["notary_pubkey"] = assigned_notary.pubkey_hex[:16]

                    body = json.dumps(payload).encode()
                    auth_headers = _sign_miner_request("/v1/attest", body, wallet)
                    resp = await client.post(
                        miner_url,
                        content=body,
                        headers={"Content-Type": "application/json", **auth_headers},
                        timeout=210.0,
                    )
                    latency = time.perf_counter() - start
                    mr["latency"] = round(latency, 1)

                    if resp.status_code != 200:
                        metrics.record_attestation(latency=latency, proof_valid=False)
                        mr["error"] = f"HTTP {resp.status_code}"
                        mr["valid"] = False
                        log.debug("attest_challenge_error", uid=uid, status=resp.status_code)
                        per_miner.append(mr)
                        return True, False

                    try:
                        data = resp.json()
                    except Exception:
                        log.warning(
                            "attest_challenge_malformed_json",
                            uid=uid,
                            response_text=resp.text[:300] if hasattr(resp, "text") else "<no text>",
                        )
                        metrics.record_attestation(latency=latency, proof_valid=False)
                        mr["error"] = "malformed JSON"
                        mr["valid"] = False
                        per_miner.append(mr)
                        return True, False

                    proof_valid = data.get("success", False) and bool(data.get("proof_hex"))

                    if proof_valid:
                        try:
                            from djinn_validator.core import tlsn as tlsn_verifier
                            from urllib.parse import urlparse

                            proof_bytes = bytes.fromhex(data["proof_hex"])
                            expected_server = urlparse(url).hostname
                            # Pass the assigned notary's pubkey so the verifier
                            # accepts proofs signed by peer miners (in addition
                            # to the statically configured TRUSTED_NOTARY_KEYS).
                            notary_key = assigned_notary.pubkey_hex if assigned_notary else None
                            verify_result = await asyncio.wait_for(
                                tlsn_verifier.verify_proof(
                                    proof_bytes,
                                    expected_server=expected_server,
                                    expected_notary_key=notary_key,
                                ),
                                timeout=30.0,
                            )
                            proof_valid = verify_result.verified
                        except Exception as e:
                            log.debug("attest_challenge_verify_error", uid=uid, err=str(e))
                            proof_valid = False

                    metrics.record_attestation(latency=latency, proof_valid=proof_valid)

                    # Record notary duty on the notary miner's metrics
                    if assigned_notary:
                        notary_metrics = scorer.get_or_create(
                            assigned_notary.uid,
                            # hotkey lookup: find it from the axon list
                            next(
                                (a["hotkey"] for a in miner_axons if a["uid"] == assigned_notary.uid),
                                f"notary-{assigned_notary.uid}",
                            ),
                        )
                        notary_metrics.record_notary_duty(proof_valid)

                    mr["valid"] = proof_valid
                    mr["server"] = data.get("server_name", "")
                    if assigned_notary:
                        mr["peer_notary"] = True
                    per_miner.append(mr)
                    log.info(
                        "attest_challenge_scored", uid=uid,
                        proof_valid=proof_valid, latency_s=round(latency, 3),
                        peer_notary=assigned_notary.uid if assigned_notary else None,
                    )
                    return True, proof_valid

                except Exception as e:
                    latency = time.perf_counter() - start
                    metrics.record_attestation(latency=latency, proof_valid=False)
                    mr["latency"] = round(latency, 1)
                    mr["error"] = str(e)[:80]
                    mr["valid"] = False
                    per_miner.append(mr)
                    log.debug("attest_challenge_error", uid=uid, err=str(e))
                    return True, False

        results = await asyncio.gather(*[_challenge_one(a) for a in capable])
        ar.challenged = sum(1 for attempted, _ in results if attempted)
        ar.verified = sum(1 for _, valid in results if valid)
        ar.miner_results = per_miner

    if ar.challenged:
        log.info(
            "attest_challenge_round_complete",
            url=url,
            probed=len(reachable),
            capable=len(capable),
            challenged=ar.challenged,
            verified=ar.verified,
        )
    return ar
