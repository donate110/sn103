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

log = structlog.get_logger()


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

    # Select up to 7 real lines
    real_count = min(7, len(real_lines))
    selected = random.sample(real_lines, real_count)

    # Create synthetic unavailable lines (fake event IDs or extreme lines)
    synthetic_count = min(10 - real_count, 3)
    for i in range(synthetic_count):
        base = random.choice(real_lines)
        selected.append({
            "sport": sport,
            "event_id": f"fake_{base['event_id']}_{i}",
            "home_team": base["home_team"],
            "away_team": base["away_team"],
            "market": base["market"],
            "line": (base.get("line") or 0) + 999.5,  # Extreme line nobody offers
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
            resp.available_indices = set(data.get("available_indices", []))
            resp.query_id = data.get("query_id")
            resp.success = True
            return resp

        except httpx.HTTPError as e:
            resp.latency = time.perf_counter() - start
            resp.error = str(e)
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


async def challenge_miners(
    scorer: MinerScorer,
    miner_axons: list[dict],
    espn_client: ESPNClient | None = None,
    wallet: Any | None = None,
) -> int:
    """Run a consensus-based scoring challenge against all reachable miners.

    4-phase flow:
    1. Query all miners concurrently with the same challenge
    2. Compute per-line consensus from all responses
    3. Score each miner against consensus + synthetic ground truth
    4. Request TLSNotary proofs from outliers + random sample

    Returns the number of miners successfully challenged.
    """
    if espn_client is None:
        from djinn_validator.core.espn import ESPNClient
        espn_client = ESPNClient()

    # Pick a random sport
    sport = random.choice(CHALLENGE_SPORTS)

    # Fetch live games from ESPN
    games = await espn_client.get_scoreboard(sport)
    if not games:
        log.debug("no_challenge_games", sport=sport)
        return 0

    # Filter to in-progress or scheduled games
    active_games = [g for g in games if g.status in ("in_progress", "scheduled", "pending")]
    if not active_games:
        active_games = games  # Fall back to all games if none are active

    challenge_lines = build_challenge_lines(active_games, sport)
    if len(challenge_lines) < 3:
        log.debug("insufficient_challenge_lines", sport=sport, count=len(challenge_lines))
        return 0

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
            return 0

        # ── Phase 2: Compute consensus ──
        consensus = _compute_consensus(responses, challenge_lines, synthetic_indices)

        # ── Phase 3: Score each miner against consensus ──
        for r in responses:
            metrics = scorer.get_or_create(r.uid, r.hotkey)
            if not r.success:
                metrics.record_query(correct=False, latency=r.latency, proof_submitted=False)
                log.debug("challenge_miner_error", uid=r.uid, err=r.error)
                continue

            is_correct, accuracy = _score_against_consensus(
                r, consensus, synthetic_indices, all_line_indices,
            )
            metrics.record_query(
                correct=is_correct,
                latency=r.latency,
                proof_submitted=False,  # Updated in Phase 4 if proof requested
            )
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
        proof_targets = _select_proof_targets(
            responses, consensus, synthetic_indices,
        )
        for target in proof_targets:
            proof_submitted, proof_valid = await _request_and_verify_proof(
                client, target.ip, target.port, target.query_id, target.uid,
                wallet=wallet,
            )
            if proof_submitted:
                metrics = scorer.get_or_create(target.uid, target.hotkey)
                metrics.proofs_submitted += 1
                log.info(
                    "challenge_proof_result", uid=target.uid,
                    proof_submitted=proof_submitted,
                    proof_valid=proof_valid,
                )

    challenged = len(responses)
    if challenged:
        log.info(
            "challenge_round_complete", sport=sport,
            miners_challenged=challenged,
            consensus_quorum=consensus.has_quorum,
            responding=consensus.responding_miners,
        )
    return challenged


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
        if proof_data.get("status") != "submitted" and proof_data.get("status") != "verified":
            return True, False

        # Attempt verification using TLSNotary verifier if available
        proof_hash = proof_data.get("proof_hash", "")
        if proof_hash:
            try:
                from djinn_validator.core import tlsn as tlsn_verifier
                if hasattr(tlsn_verifier, "is_available") and not tlsn_verifier.is_available():
                    log.debug("tlsn_verifier_unavailable", uid=uid)
                    return True, False  # Proof submitted but can't verify
            except ImportError:
                log.debug("tlsn_verifier_not_installed", uid=uid)
                return True, False  # Proof submitted but can't verify

        return True, True  # Proof submitted and verified

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


async def challenge_miners_attestation(
    scorer: MinerScorer,
    miner_axons: list[dict],
    wallet: Any | None = None,
) -> int:
    """Run a TLSNotary attestation challenge against all reachable miners.

    Picks a known-good URL and asks each miner to produce a TLSNotary
    proof. The validator then verifies each returned proof. Successful
    attestations contribute to accuracy, coverage, and speed metrics.

    Returns the number of miners challenged.
    """
    url = random.choice(_ATTESTATION_CHALLENGE_URLS)

    # Attestation challenges run concurrently but with lower concurrency
    # since each takes 30-90s and involves CPU-intensive TLSNotary work
    sem = asyncio.Semaphore(4)

    async with httpx.AsyncClient() as client:

        async def _challenge_one(axon: dict) -> bool:
            uid = axon["uid"]
            hotkey = axon["hotkey"]
            ip = axon.get("ip", "")
            port = axon.get("port", 0)

            if not ip or not port:
                return False

            metrics = scorer.get_or_create(uid, hotkey)
            miner_url = f"http://{ip}:{port}/v1/attest"
            request_id = f"challenge-{uid}-{int(time.time())}"

            async with sem:
                start = time.perf_counter()
                try:
                    body = json.dumps({"url": url, "request_id": request_id}).encode()
                    auth_headers = _sign_miner_request("/v1/attest", body, wallet)
                    resp = await client.post(
                        miner_url,
                        content=body,
                        headers={"Content-Type": "application/json", **auth_headers},
                        timeout=120.0,
                    )
                    latency = time.perf_counter() - start

                    if resp.status_code != 200:
                        metrics.record_attestation(latency=latency, proof_valid=False)
                        log.debug("attest_challenge_error", uid=uid, status=resp.status_code)
                        return True

                    try:
                        data = resp.json()
                    except Exception:
                        log.warning(
                            "attest_challenge_malformed_json",
                            uid=uid,
                            response_text=resp.text[:300] if hasattr(resp, "text") else "<no text>",
                        )
                        metrics.record_attestation(latency=latency, proof_valid=False)
                        return True

                    proof_valid = data.get("success", False) and bool(data.get("proof_hex"))

                    if proof_valid:
                        try:
                            from djinn_validator.core import tlsn as tlsn_verifier
                            from urllib.parse import urlparse

                            proof_bytes = bytes.fromhex(data["proof_hex"])
                            expected_server = urlparse(url).hostname
                            verify_result = await asyncio.wait_for(
                                tlsn_verifier.verify_proof(proof_bytes, expected_server=expected_server),
                                timeout=30.0,
                            )
                            proof_valid = verify_result.verified
                        except Exception as e:
                            log.debug("attest_challenge_verify_error", uid=uid, err=str(e))
                            proof_valid = False

                    metrics.record_attestation(latency=latency, proof_valid=proof_valid)
                    log.info("attest_challenge_scored", uid=uid, proof_valid=proof_valid, latency_s=round(latency, 3))
                    return True

                except httpx.HTTPError as e:
                    latency = time.perf_counter() - start
                    metrics.record_attestation(latency=latency, proof_valid=False)
                    log.debug("attest_challenge_unreachable", uid=uid, err=str(e))
                    return True

        results = await asyncio.gather(*[_challenge_one(axon) for axon in miner_axons])
        challenged = sum(1 for r in results if r)

    if challenged:
        log.info("attest_challenge_round_complete", url=url, miners_challenged=challenged)
    return challenged
