"""Miner scoring module — implements split sports/attestation scoring.

Sports challenge weights (executability checks via The Odds API):
  - Accuracy:   35%  (Phase 1 matches TLSNotary ground truth)
  - Speed:      25%  (Response latency, normalized across miners)
  - Coverage:   15%  (% of queries with valid TLSNotary proof)
  - Uptime:     15%  (% of epochs responding to health checks)
  - Capability: 10%  (System resource capability bonus)

Attestation challenge weights (web attestation via TLSNotary, mandatory):
  - Proof validity: 60%  (TLSNotary proof verifies correctly)
  - Speed:          40%  (Attestation latency, normalized independently)

Blending: final_score = (1 - W_ATTESTATION) * sports + W_ATTESTATION * attestation
Default W_ATTESTATION = 0.30 — raised from 0.20 for early subnet where sports
data is sparse and attestation is the primary differentiator.

Empty epoch weights (no active signals):
  Without attestation data:
  - Uptime:  50%
  - History: 50%  (Consecutive participation, log-scaled)
  With attestation data:
  - Uptime:      35%
  - History:     30%
  - Attestation: 35%  (Same attestation scoring as active epochs)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import structlog

log = structlog.get_logger()


@dataclass
class MinerMetrics:
    """Accumulated metrics for a single miner within a scoring window."""

    uid: int
    hotkey: str

    # ── Sports challenge metrics ──
    queries_total: int = 0
    queries_correct: int = 0  # Phase 1 matched TLSNotary truth
    latencies: list[float] = field(default_factory=list)
    proofs_submitted: int = 0  # queries where miner returned a proof
    proofs_verified: int = 0  # proofs that passed TLSNotary verification

    # ── Attestation challenge metrics (separate from sports) ──
    attestations_total: int = 0
    attestations_valid: int = 0  # TLSNotary proof verified
    attestation_latencies: list[float] = field(default_factory=list)

    # ── Proof-request tracking ──
    proofs_requested: int = 0  # times miner was asked to submit proof

    # ── Proactive attestation (survives epoch resets) ──
    proactive_proof_verified: bool = False  # miner has a fresh, verified proactive proof

    # ── Notary service metrics (peer-to-peer notarization) ──
    notary_duties_assigned: int = 0  # times assigned as notary for another miner
    notary_duties_completed: int = 0  # times the proof using this notary verified
    notary_capable: bool = False  # running a notary sidecar (discovered this epoch)

    # ── Capability advertisement (from health check) ──
    memory_total_mb: int = 0
    memory_available_mb: int = 0
    cpu_cores: int = 0
    cpu_load_1m: float = 0.0
    tlsn_max_concurrent: int = 0
    tlsn_active_sessions: int = 0
    notary_max_concurrent: int = 0
    notary_active_sessions: int = 0
    disk_free_gb: float = 0.0
    capabilities_reported: bool = False  # True if miner reports capabilities

    # ── Shared metrics ──
    health_checks_total: int = 0
    health_checks_responded: int = 0
    consecutive_epochs: int = 0

    def accuracy_score(self) -> float:
        """Fraction of sports queries where Phase 1 result matched ground truth."""
        if self.queries_total == 0:
            return 0.0
        return self.queries_correct / self.queries_total

    def coverage_score(self) -> float:
        """Fraction of proof requests where miner's proof was verified.

        Only TLSNotary-verified proofs count. Submitting an unverifiable
        proof (HTTP hash, missing presentation bytes) earns no coverage.
        """
        if self.proofs_requested == 0:
            return 0.0
        return self.proofs_verified / self.proofs_requested

    def uptime_score(self) -> float:
        """Fraction of health checks responded to."""
        if self.health_checks_total == 0:
            return 0.0
        return self.health_checks_responded / self.health_checks_total

    def attestation_validity_score(self) -> float:
        """Fraction of attestation challenges with valid TLSNotary proof."""
        if self.attestations_total == 0:
            return 0.0
        return self.attestations_valid / self.attestations_total

    def record_query(
        self,
        correct: bool,
        latency: float,
        proof_submitted: bool,
        proof_status: str = "",
    ) -> None:
        """Record a single sports query result.

        If proof_status is "unverified", the query is never counted as
        correct regardless of the ``correct`` flag — unverified proofs
        cannot be trusted for accuracy scoring (R25-18).
        """
        self.queries_total += 1
        if proof_status == "unverified":
            log.warning(
                "unverified_proof_zero_accuracy",
                uid=self.uid,
                hotkey=self.hotkey,
            )
        elif correct:
            self.queries_correct += 1
        self.latencies.append(latency)
        if proof_submitted:
            self.proofs_submitted += 1

    def record_health_check(self, responded: bool) -> None:
        """Record a health check result."""
        self.health_checks_total += 1
        if responded:
            self.health_checks_responded += 1

    def record_attestation(self, latency: float, proof_valid: bool) -> None:
        """Record a web attestation challenge result (separate from sports)."""
        self.attestations_total += 1
        if proof_valid:
            self.attestations_valid += 1
        # Only record real latencies (skip latency=0 from known-broken miner
        # auto-scoring, which would pollute speed normalization)
        if latency > 0:
            self.attestation_latencies.append(latency)

    def notary_reliability(self) -> float:
        """Fraction of notary assignments that produced a verified proof."""
        if self.notary_duties_assigned == 0:
            return 0.0
        return self.notary_duties_completed / self.notary_duties_assigned

    def record_notary_duty(self, proof_valid: bool) -> None:
        """Record that this miner served as notary for another miner's proof."""
        self.notary_duties_assigned += 1
        if proof_valid:
            self.notary_duties_completed += 1

    def update_capabilities(
        self,
        memory_total_mb: int,
        memory_available_mb: int,
        cpu_cores: int,
        cpu_load_1m: float,
        tlsn_max_concurrent: int,
        tlsn_active_sessions: int,
        notary_max_concurrent: int,
        notary_active_sessions: int,
        disk_free_gb: float,
    ) -> None:
        """Update capability metrics from health check response."""
        self.memory_total_mb = memory_total_mb
        self.memory_available_mb = memory_available_mb
        self.cpu_cores = cpu_cores
        self.cpu_load_1m = cpu_load_1m
        self.tlsn_max_concurrent = tlsn_max_concurrent
        self.tlsn_active_sessions = tlsn_active_sessions
        self.notary_max_concurrent = notary_max_concurrent
        self.notary_active_sessions = notary_active_sessions
        self.disk_free_gb = disk_free_gb
        self.capabilities_reported = True


class MinerScorer:
    """Computes normalized scores across all miners for weight setting.

    Sports and attestation challenges are scored independently then blended.
    This ensures attestation-focused miners are fairly rewarded (~$0.02/attestation
    burn cost recouped via emission share at equilibrium).
    """

    # ── Sports challenge weights ──
    W_ACCURACY = 0.35
    W_SPEED = 0.25
    W_COVERAGE = 0.15
    W_UPTIME = 0.15
    W_CAPABILITY = 0.10  # Resource capability bonus

    # ── Attestation challenge weights ──
    W_ATTEST_VALIDITY = 0.60  # TLSNotary proof correctness
    W_ATTEST_SPEED = 0.40     # Normalized attestation latency

    # ── Blend weight: how much attestation contributes to final score ──
    # 30% attestation / 70% sports. Raised from 0.20 for early subnet where
    # sports data is sparse and attestation is the primary differentiator.
    W_ATTESTATION_BLEND = 0.30

    # ── Empty epoch weights (no attestation data) ──
    W_EMPTY_UPTIME = 0.50
    W_EMPTY_HISTORY = 0.50

    # ── Empty epoch weights (with attestation data) ──
    W_EMPTY_UPTIME_A = 0.35
    W_EMPTY_HISTORY_A = 0.30
    W_EMPTY_ATTESTATION = 0.35

    def __init__(self, attestation_blend: float | None = None) -> None:
        self._miners: dict[int, MinerMetrics] = {}
        if attestation_blend is not None:
            self.W_ATTESTATION_BLEND = attestation_blend

    def get(self, uid: int) -> MinerMetrics | None:
        """Get metrics for a miner without creating or resetting."""
        return self._miners.get(uid)

    def get_or_create(self, uid: int, hotkey: str) -> MinerMetrics:
        """Get or create metrics for a miner.

        If the hotkey changed (miner deregistered and a new one took the UID),
        reset all metrics so the new miner starts fresh.
        """
        existing = self._miners.get(uid)
        if existing is not None:
            if existing.hotkey != hotkey:
                log.info("miner_hotkey_changed", uid=uid, old=existing.hotkey, new=hotkey)
                self._miners[uid] = MinerMetrics(uid=uid, hotkey=hotkey)
            return self._miners[uid]
        self._miners[uid] = MinerMetrics(uid=uid, hotkey=hotkey)
        return self._miners[uid]

    def remove(self, uid: int) -> None:
        """Remove a deregistered miner."""
        self._miners.pop(uid, None)

    def prune_absent(self, active_uids: set[int]) -> int:
        """Remove metrics for UIDs no longer on the metagraph. Returns count pruned."""
        stale = [uid for uid in self._miners if uid not in active_uids]
        for uid in stale:
            del self._miners[uid]
        if stale:
            log.info("scorer_pruned_absent", count=len(stale), uids=stale)
        return len(stale)

    def compute_weights(self, is_active_epoch: bool) -> dict[int, float]:
        """Compute normalized weights for all tracked miners.

        Returns:
            Mapping of miner UID -> weight (0.0 to 1.0), normalized to sum to 1.
        """
        weights, _ = self.compute_weights_detailed(is_active_epoch)
        return weights

    def compute_weights_detailed(
        self, is_active_epoch: bool
    ) -> tuple[dict[int, float], dict[int, dict]]:
        """Compute normalized weights with per-miner component breakdowns.

        Returns:
            (weights, breakdowns) where weights maps uid -> normalized weight,
            and breakdowns maps uid -> component scores dict.
        """
        if not self._miners:
            return {}, {}

        if is_active_epoch:
            return self._compute_active_weights_detailed()
        return self._compute_empty_weights_detailed()

    def _compute_active_weights(self) -> dict[int, float]:
        weights, _ = self._compute_active_weights_detailed()
        return weights

    def _compute_active_weights_detailed(
        self,
    ) -> tuple[dict[int, float], dict[int, dict]]:
        miners = list(self._miners.values())

        sports_scores = self._compute_sports_scores(miners)
        attestation_scores = self._compute_attestation_scores(miners)
        sports_speed = self._normalize_speed(miners, use_attestation=False)
        attest_speed = self._normalize_speed(miners, use_attestation=True)
        capability_scores = self._compute_capability_scores([m.uid for m in miners])

        has_attestation_data = any(m.attestations_total > 0 for m in miners)

        raw: dict[int, float] = {}
        breakdowns: dict[int, dict] = {}
        for m in miners:
            sports = sports_scores.get(m.uid, 0.0)
            attest = attestation_scores.get(m.uid, 0.0) if has_attestation_data else 0.0
            if has_attestation_data:
                score = (
                    (1.0 - self.W_ATTESTATION_BLEND) * sports
                    + self.W_ATTESTATION_BLEND * attest
                )
            else:
                score = sports

            # Miners that were challenged for attestation but never produced
            # a valid proof are penalized heavily. Being online isn't enough;
            # you must be able to do the work when asked. Miners that haven't
            # been challenged yet (attestations_total == 0) are unaffected.
            if m.attestations_total > 0 and m.attestations_valid == 0 and not m.proactive_proof_verified:
                score *= 0.05  # 95% penalty

            raw[m.uid] = score
            breakdowns[m.uid] = {
                "accuracy": m.accuracy_score(),
                "speed": sports_speed.get(m.uid, 0.0),
                "coverage": m.coverage_score(),
                "uptime": m.uptime_score(),
                "capability_score": capability_scores.get(m.uid, 0.3),
                "memory_total_mb": m.memory_total_mb,
                "cpu_cores": m.cpu_cores,
                "capabilities_reported": m.capabilities_reported,
                "sports_score": sports,
                "attest_validity": m.attestation_validity_score(),
                "attest_speed": attest_speed.get(m.uid, 0.0),
                "attestation_score": attest,
                "raw_score": score,
                "queries_total": m.queries_total,
                "queries_correct": m.queries_correct,
                "attestations_total": m.attestations_total,
                "attestations_valid": m.attestations_valid,
                "health_checks_total": m.health_checks_total,
                "health_checks_responded": m.health_checks_responded,
                "consecutive_epochs": m.consecutive_epochs,
                "notary_duties_assigned": m.notary_duties_assigned,
                "notary_duties_completed": m.notary_duties_completed,
                "notary_reliability": round(m.notary_reliability(), 4),
                "notary_capable": m.notary_capable,
            }

        return self._normalize(raw), breakdowns

    def _compute_sports_scores(self, miners: list[MinerMetrics]) -> dict[int, float]:
        """Compute per-miner sports scores (unnormalized 0-1 range).

        Miners with no sports queries get 0 — no free speed credit for
        miners that haven't been challenged or haven't responded.

        Notary bonus: miners who reliably serve as peer notaries get up to
        a 10% bonus on their uptime component. This rewards network service
        without changing weight structure (backwards compatible).
        """
        speed_scores = self._normalize_speed(miners, use_attestation=False)
        capability_scores = self._compute_capability_scores([m.uid for m in miners])

        scores: dict[int, float] = {}
        for m in miners:
            # Notary bonus: up to 10% boost on the uptime component
            notary_bonus = 1.0 + 0.10 * m.notary_reliability()
            uptime = m.uptime_score() * notary_bonus
            cap_score = capability_scores.get(m.uid, 0.3)
            if m.queries_total == 0:
                scores[m.uid] = self.W_UPTIME * uptime + self.W_CAPABILITY * cap_score
            else:
                scores[m.uid] = (
                    self.W_ACCURACY * m.accuracy_score()
                    + self.W_SPEED * speed_scores.get(m.uid, 0.0)
                    + self.W_COVERAGE * m.coverage_score()
                    + self.W_UPTIME * uptime
                    + self.W_CAPABILITY * cap_score
                )
        return scores

    # Miners without a notary sidecar get this multiplier on attestation score.
    # They benefit from the network's notary infrastructure without contributing.
    NOTARY_FREERIDER_PENALTY = 0.5

    def _compute_attestation_scores(self, miners: list[MinerMetrics]) -> dict[int, float]:
        """Compute per-miner attestation scores (unnormalized 0-1 range).

        Attestation scoring uses only two axes:
        - Proof validity (60%): did TLSNotary proof verify?
        - Speed (40%): how fast was the attestation?

        Miners not running a notary sidecar receive a 50% penalty on their
        attestation score. This incentivizes every operator to contribute
        notary capacity proportional to their miner count.
        """
        speed_scores = self._normalize_speed(miners, use_attestation=True)

        scores: dict[int, float] = {}
        for m in miners:
            if m.attestations_total == 0:
                scores[m.uid] = 0.0
            else:
                base = (
                    self.W_ATTEST_VALIDITY * m.attestation_validity_score()
                    + self.W_ATTEST_SPEED * speed_scores.get(m.uid, 0.0)
                )
                if not m.notary_capable:
                    base *= self.NOTARY_FREERIDER_PENALTY
                scores[m.uid] = base
        return scores

    def _compute_capability_scores(self, uids: list[int]) -> dict[int, float]:
        """Score miners based on advertised system capabilities.

        Scoring formula (0-1 range):
        - Memory tier: 0-0.4 based on total RAM (8GB=0.1, 16GB=0.2, 32GB=0.3, 64GB+=0.4)
        - CPU tier: 0-0.2 based on core count (4=0.05, 8=0.1, 16=0.15, 32+=0.2)
        - Availability: 0-0.2 based on memory_available / memory_total ratio
        - Capacity headroom: 0-0.2 based on (max - active) / max for TLSNotary sessions

        Miners that don't report capabilities get 0.3 (neutral, not penalized heavily).
        """
        scores: dict[int, float] = {}
        for uid in uids:
            m = self._miners.get(uid)
            if m is None or not m.capabilities_reported:
                scores[uid] = 0.3  # Neutral score for non-reporting miners
                continue

            score = 0.0

            # Memory tier (0-0.4)
            mem_gb = m.memory_total_mb / 1024
            if mem_gb >= 64:
                score += 0.4
            elif mem_gb >= 32:
                score += 0.3
            elif mem_gb >= 16:
                score += 0.2
            elif mem_gb >= 8:
                score += 0.1

            # CPU tier (0-0.2)
            if m.cpu_cores >= 32:
                score += 0.2
            elif m.cpu_cores >= 16:
                score += 0.15
            elif m.cpu_cores >= 8:
                score += 0.1
            elif m.cpu_cores >= 4:
                score += 0.05

            # Memory availability (0-0.2)
            if m.memory_total_mb > 0:
                avail_ratio = m.memory_available_mb / m.memory_total_mb
                score += min(0.2, avail_ratio * 0.2)

            # Session headroom (0-0.2)
            if m.tlsn_max_concurrent > 0:
                headroom = (m.tlsn_max_concurrent - m.tlsn_active_sessions) / m.tlsn_max_concurrent
                score += min(0.2, max(0.0, headroom) * 0.2)
            elif m.capabilities_reported:
                score += 0.1  # No TLSNotary info but reports other caps

            scores[uid] = min(1.0, score)

        return scores

    def _compute_empty_weights(self) -> dict[int, float]:
        weights, _ = self._compute_empty_weights_detailed()
        return weights

    def _compute_empty_weights_detailed(
        self,
    ) -> tuple[dict[int, float], dict[int, dict]]:
        miners = list(self._miners.values())
        max_history = max((m.consecutive_epochs for m in miners), default=1)

        has_attestation_data = any(m.attestations_total > 0 for m in miners)
        attestation_scores = self._compute_attestation_scores(miners) if has_attestation_data else {}

        attest_speed = self._normalize_speed(miners, use_attestation=True)

        raw: dict[int, float] = {}
        breakdowns: dict[int, dict] = {}
        for m in miners:
            history = math.log1p(m.consecutive_epochs) / math.log1p(max_history) if max_history > 0 else 0.0
            attest = attestation_scores.get(m.uid, 0.0)
            if has_attestation_data:
                score = (
                    self.W_EMPTY_UPTIME_A * m.uptime_score()
                    + self.W_EMPTY_HISTORY_A * history
                    + self.W_EMPTY_ATTESTATION * attest
                )
            else:
                score = self.W_EMPTY_UPTIME * m.uptime_score() + self.W_EMPTY_HISTORY * history

            # Same penalty as active epochs: challenged but never verified = near zero
            if m.attestations_total > 0 and m.attestations_valid == 0 and not m.proactive_proof_verified:
                score *= 0.05

            raw[m.uid] = score
            breakdowns[m.uid] = {
                "accuracy": 0.0,
                "speed": 0.0,
                "coverage": 0.0,
                "uptime": m.uptime_score(),
                "sports_score": 0.0,
                "attest_validity": m.attestation_validity_score(),
                "attest_speed": attest_speed.get(m.uid, 0.0),
                "attestation_score": attest,
                "history": round(history, 4),
                "raw_score": score,
                "queries_total": m.queries_total,
                "queries_correct": m.queries_correct,
                "attestations_total": m.attestations_total,
                "attestations_valid": m.attestations_valid,
                "health_checks_total": m.health_checks_total,
                "health_checks_responded": m.health_checks_responded,
                "consecutive_epochs": m.consecutive_epochs,
                "notary_duties_assigned": m.notary_duties_assigned,
                "notary_duties_completed": m.notary_duties_completed,
                "notary_reliability": round(m.notary_reliability(), 4),
                "notary_capable": m.notary_capable,
            }

        return self._normalize(raw), breakdowns

    def _normalize_speed(
        self, miners: list[MinerMetrics], *, use_attestation: bool = False
    ) -> dict[int, float]:
        """Normalize speed scores: fastest miner gets 1.0, slowest gets 0.0.

        Args:
            use_attestation: If True, uses attestation_latencies instead of
                sports latencies. This ensures the two challenge types are
                normalized independently (attestation takes 30-90s vs <10s
                for sports).
        """
        avg_latencies: dict[int, float] = {}
        for m in miners:
            lats = m.attestation_latencies if use_attestation else m.latencies
            if lats:
                avg_latencies[m.uid] = sum(lats) / len(lats)

        if not avg_latencies:
            return {m.uid: 0.0 for m in miners}

        min_lat = min(avg_latencies.values())
        max_lat = max(avg_latencies.values())
        spread = max_lat - min_lat

        if spread == 0:
            return {uid: 1.0 for uid in avg_latencies} | {m.uid: 0.0 for m in miners if m.uid not in avg_latencies}

        scores = {uid: 1.0 - (lat - min_lat) / spread for uid, lat in avg_latencies.items()}
        for m in miners:
            if m.uid not in scores:
                scores[m.uid] = 0.0
        return scores

    @staticmethod
    def _normalize(raw: dict[int, float]) -> dict[int, float]:
        """Normalize weights to sum to 1.0.

        Uses epsilon comparison to avoid division by near-zero floating point sums
        that could produce Infinity or extremely large weights. Validates all
        outputs are finite to prevent inf/nan propagation to on-chain weight setting.
        """
        total = sum(raw.values())
        if total < 1e-12:
            return {uid: 0.0 for uid in raw}
        result = {uid: score / total for uid, score in raw.items()}
        if not all(math.isfinite(v) for v in result.values()):
            return {uid: 0.0 for uid in result}
        return result

    def select_attest_miners(self, candidate_uids: list[int], max_results: int = 5) -> list[tuple[int, str]]:
        """Select the best miners for attestation dispatch.

        Returns list of (uid, tier) tuples where tier is:
        - "proven": produced at least one valid attestation proof
        - "unproven": responds to health checks but hasn't been challenged yet
        - "redemption": previously failed but gets a short-timeout retry chance

        Miners cycle through tiers naturally: excluded miners get a redemption
        slot (1 per dispatch, short timeout) so they can recover after fixing
        issues like missing TLSNotary binaries.

        Args:
            candidate_uids: UIDs with valid axon info (IP/port).
            max_results: Maximum number of candidates to return.
        """
        import random

        proven: list[tuple[int, float, float]] = []  # (uid, validity_score, median_latency)
        unproven: list[int] = []
        excluded: list[int] = []

        for uid in candidate_uids:
            m = self._miners.get(uid)
            if m is None:
                # Never seen — treat as unproven
                unproven.append(uid)
                continue

            if m.attestations_valid > 0 or m.proactive_proof_verified:
                # Tier 1: has produced valid proofs (challenge or proactive)
                med_lat = sorted(m.attestation_latencies)[len(m.attestation_latencies) // 2] if m.attestation_latencies else 999.0
                proven.append((uid, m.attestation_validity_score(), med_lat))
            elif m.attestations_total > 0:
                # Tier 3: challenged but never succeeded — track for redemption
                excluded.append(uid)
            elif m.health_checks_responded > 0:
                # Tier 2: responsive but never challenged for attestation
                unproven.append(uid)
            else:
                # After epoch reset: all counters zero but entry exists.
                # Treat same as unproven so miners aren't invisible.
                unproven.append(uid)

        # Sort proven: highest validity first, then fastest, prefer available capacity
        def _proven_sort_key(t: tuple[int, float, float]) -> tuple[float, float, float]:
            uid, validity, latency = t
            m = self._miners.get(uid)
            # Prefer miners with TLSNotary capacity headroom
            headroom = 0.0
            if m and m.capabilities_reported and m.tlsn_max_concurrent > 0:
                headroom = (m.tlsn_max_concurrent - m.tlsn_active_sessions) / m.tlsn_max_concurrent
            return (-validity, -headroom, latency)

        proven.sort(key=_proven_sort_key)

        result: list[tuple[int, str]] = []
        for uid, _, _ in proven:
            if len(result) >= max_results:
                break
            result.append((uid, "proven"))

        # Fill remaining slots with up to 2 random unproven miners
        unproven_limit = min(2, max_results - len(result))
        random.shuffle(unproven)
        for uid in unproven[:unproven_limit]:
            result.append((uid, "unproven"))

        # Redemption: give 1 random excluded miner a retry chance.
        # Short timeout (handled by caller via "redemption" tier) so it
        # doesn't slow down dispatch if the miner is still broken.
        if excluded and len(result) < max_results:
            pick = random.choice(excluded)
            result.append((pick, "redemption"))
            log.info("attest_redemption_slot", uid=pick, excluded_count=len(excluded))

        return result

    def rank_notary_candidates(self, candidate_uids: list[int]) -> list[tuple[int, float]]:
        """Rank notary candidates by MPC reliability for external prover assignment.

        Combines attestation validity (can this miner complete a TLSNotary proof?)
        with notary duty reliability (does its sidecar stay up through MPC?) and
        uptime. Returns all candidates sorted best-first.

        Returns list of (uid, score) where score is 0.0-1.0.
        """
        scored: list[tuple[int, float]] = []

        for uid in candidate_uids:
            m = self._miners.get(uid)
            if m is None:
                # Never seen by scorer: put at the bottom with zero score
                scored.append((uid, 0.0))
                continue

            # Primary signal: has this miner's notary sidecar produced verified
            # proofs when assigned as notary for other miners?
            nr = m.notary_reliability()  # 0.0 if never assigned

            # Secondary: can this miner itself produce valid attestation proofs?
            # Miners that pass attestation challenges have working TLSNotary stacks.
            av = m.attestation_validity_score()

            # Tertiary: basic liveness
            up = m.uptime_score()

            # Combine. Notary reliability is the strongest signal because it
            # directly measures "did MPC complete when this miner was the notary?"
            # Attestation validity measures the full stack health. Uptime is a
            # tiebreaker for miners with no attestation/notary history.
            # Capacity factor: prefer notaries with available sessions
            cap_factor = 1.0
            if m.capabilities_reported and m.notary_max_concurrent > 0:
                active_ratio = m.notary_active_sessions / m.notary_max_concurrent
                cap_factor = 1.0 - (active_ratio * 0.3)  # Up to 30% penalty when fully loaded

            if m.notary_duties_assigned > 0:
                # Has served as notary before: weight heavily on that track record
                score = (0.50 * nr + 0.35 * av + 0.15 * up) * cap_factor
            elif m.attestations_total > 0:
                # Never assigned as notary but has attestation history
                score = (0.60 * av + 0.40 * up) * cap_factor
            else:
                # No history at all: score on uptime only
                score = 0.30 * up * cap_factor  # Cap at 0.30 so proven miners always rank above

            scored.append((uid, score))

        # Best first
        scored.sort(key=lambda t: -t[1])
        return scored

    def reset_epoch(self) -> None:
        """Reset per-epoch metrics while preserving history.

        Increments consecutive_epochs for miners that participated (responded
        to at least one health check, answered a query, or completed an attestation).
        """
        for m in self._miners.values():
            participated = (
                m.queries_total > 0
                or m.health_checks_responded > 0
                or m.attestations_total > 0
                or m.notary_duties_assigned > 0
            )
            if participated:
                m.consecutive_epochs += 1
            else:
                m.consecutive_epochs = 0
            # Reset sports metrics
            m.queries_total = 0
            m.queries_correct = 0
            m.latencies.clear()
            m.proofs_submitted = 0
            m.proofs_verified = 0
            m.proofs_requested = 0
            # Reset attestation metrics
            m.attestations_total = 0
            m.attestations_valid = 0
            m.attestation_latencies.clear()
            # Reset notary metrics
            m.notary_duties_assigned = 0
            m.notary_duties_completed = 0
            m.notary_capable = False
            # Reset health checks
            m.health_checks_total = 0
            m.health_checks_responded = 0
