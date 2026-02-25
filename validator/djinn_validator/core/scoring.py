"""Miner scoring module — implements split sports/attestation scoring.

Sports challenge weights (executability checks via The Odds API):
  - Accuracy: 40%  (Phase 1 matches TLSNotary ground truth)
  - Speed:    25%  (Response latency, normalized across miners)
  - Coverage: 20%  (% of queries with valid TLSNotary proof)
  - Uptime:   15%  (% of epochs responding to health checks)

Attestation challenge weights (web attestation via TLSNotary, mandatory):
  - Proof validity: 60%  (TLSNotary proof verifies correctly)
  - Speed:          40%  (Attestation latency, normalized independently)

Blending: final_score = (1 - W_ATTESTATION) * sports + W_ATTESTATION * attestation
Default W_ATTESTATION = 0.20 — tuned so attestation miners recoup the ~$0.02
burn cost in equilibrium via emission share.

Empty epoch weights (no active signals):
  - Uptime:  50%
  - History: 50%  (Consecutive participation, log-scaled)
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
    proofs_submitted: int = 0  # queries with valid TLSNotary proof

    # ── Attestation challenge metrics (separate from sports) ──
    attestations_total: int = 0
    attestations_valid: int = 0  # TLSNotary proof verified
    attestation_latencies: list[float] = field(default_factory=list)

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
        """Fraction of sports queries with valid TLSNotary proof."""
        if self.queries_total == 0:
            return 0.0
        return self.proofs_submitted / self.queries_total

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
        self.attestation_latencies.append(latency)


class MinerScorer:
    """Computes normalized scores across all miners for weight setting.

    Sports and attestation challenges are scored independently then blended.
    This ensures attestation-focused miners are fairly rewarded (~$0.02/attestation
    burn cost recouped via emission share at equilibrium).
    """

    # ── Sports challenge weights ──
    W_ACCURACY = 0.40
    W_SPEED = 0.25
    W_COVERAGE = 0.20
    W_UPTIME = 0.15

    # ── Attestation challenge weights ──
    W_ATTEST_VALIDITY = 0.60  # TLSNotary proof correctness
    W_ATTEST_SPEED = 0.40     # Normalized attestation latency

    # ── Blend weight: how much attestation contributes to final score ──
    # 20% attestation / 80% sports. Tuned so miners doing attestation work
    # recoup the ~$0.02 alpha burn in emission share at equilibrium.
    W_ATTESTATION_BLEND = 0.20

    # ── Empty epoch weights ──
    W_EMPTY_UPTIME = 0.50
    W_EMPTY_HISTORY = 0.50

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
        if not self._miners:
            return {}

        if is_active_epoch:
            return self._compute_active_weights()
        return self._compute_empty_weights()

    def _compute_active_weights(self) -> dict[int, float]:
        miners = list(self._miners.values())

        sports_scores = self._compute_sports_scores(miners)
        attestation_scores = self._compute_attestation_scores(miners)

        has_attestation_data = any(m.attestations_total > 0 for m in miners)

        raw: dict[int, float] = {}
        for m in miners:
            sports = sports_scores.get(m.uid, 0.0)
            if has_attestation_data:
                attest = attestation_scores.get(m.uid, 0.0)
                score = (
                    (1.0 - self.W_ATTESTATION_BLEND) * sports
                    + self.W_ATTESTATION_BLEND * attest
                )
            else:
                # No attestation challenges this epoch — pure sports scoring
                score = sports
            raw[m.uid] = score

        return self._normalize(raw)

    def _compute_sports_scores(self, miners: list[MinerMetrics]) -> dict[int, float]:
        """Compute per-miner sports scores (unnormalized 0-1 range)."""
        speed_scores = self._normalize_speed(miners, use_attestation=False)

        scores: dict[int, float] = {}
        for m in miners:
            scores[m.uid] = (
                self.W_ACCURACY * m.accuracy_score()
                + self.W_SPEED * speed_scores.get(m.uid, 0.0)
                + self.W_COVERAGE * m.coverage_score()
                + self.W_UPTIME * m.uptime_score()
            )
        return scores

    def _compute_attestation_scores(self, miners: list[MinerMetrics]) -> dict[int, float]:
        """Compute per-miner attestation scores (unnormalized 0-1 range).

        Attestation scoring uses only two axes:
        - Proof validity (60%): did TLSNotary proof verify?
        - Speed (40%): how fast was the attestation?

        TLSNotary is mandatory for attestation (not optional like sports
        coverage). A miner with no attestation challenges gets 0.
        """
        speed_scores = self._normalize_speed(miners, use_attestation=True)

        scores: dict[int, float] = {}
        for m in miners:
            scores[m.uid] = (
                self.W_ATTEST_VALIDITY * m.attestation_validity_score()
                + self.W_ATTEST_SPEED * speed_scores.get(m.uid, 0.0)
            )
        return scores

    def _compute_empty_weights(self) -> dict[int, float]:
        miners = list(self._miners.values())
        max_history = max((m.consecutive_epochs for m in miners), default=1)

        raw: dict[int, float] = {}
        for m in miners:
            # Log-scaled history: log(1 + epochs) / log(1 + max_epochs)
            history = math.log1p(m.consecutive_epochs) / math.log1p(max_history) if max_history > 0 else 0.0
            score = self.W_EMPTY_UPTIME * m.uptime_score() + self.W_EMPTY_HISTORY * history
            raw[m.uid] = score

        return self._normalize(raw)

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
            return {m.uid: 1.0 for m in miners}

        min_lat = min(avg_latencies.values())
        max_lat = max(avg_latencies.values())
        spread = max_lat - min_lat

        if spread == 0:
            return {m.uid: 1.0 for m in miners}

        scores = {uid: 1.0 - (lat - min_lat) / spread for uid, lat in avg_latencies.items()}
        median = sorted(scores.values())[len(scores) // 2] if scores else 1.0
        for m in miners:
            if m.uid not in scores:
                scores[m.uid] = median
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
            n = len(raw)
            return {uid: 1.0 / n for uid in raw} if n > 0 else {}
        result = {uid: score / total for uid, score in raw.items()}
        if not all(math.isfinite(v) for v in result.values()):
            n = len(result)
            return {uid: 1.0 / n for uid in result} if n > 0 else {}
        return result

    def select_attest_miners(self, candidate_uids: list[int], max_results: int = 5) -> list[tuple[int, str]]:
        """Select the best miners for attestation dispatch.

        Returns list of (uid, tier) tuples where tier is "proven" or "unproven".
        Proven miners produced at least one valid attestation proof.
        Unproven miners respond to health checks but haven't been challenged yet.
        Miners that were challenged and always failed are excluded.

        Args:
            candidate_uids: UIDs with valid axon info (IP/port).
            max_results: Maximum number of candidates to return.
        """
        proven: list[tuple[int, float, float]] = []  # (uid, validity_score, median_latency)
        unproven: list[int] = []

        for uid in candidate_uids:
            m = self._miners.get(uid)
            if m is None:
                # Never seen — treat as unproven
                unproven.append(uid)
                continue

            if m.attestations_valid > 0:
                # Tier 1: has produced valid proofs
                med_lat = sorted(m.attestation_latencies)[len(m.attestation_latencies) // 2] if m.attestation_latencies else 999.0
                proven.append((uid, m.attestation_validity_score(), med_lat))
            elif m.attestations_total > 0:
                # Tier 3: challenged but never succeeded — skip
                continue
            elif m.health_checks_responded > 0:
                # Tier 2: responsive but never challenged for attestation
                unproven.append(uid)

        # Sort proven: highest validity first, then fastest
        proven.sort(key=lambda t: (-t[1], t[2]))

        result: list[tuple[int, str]] = []
        for uid, _, _ in proven:
            if len(result) >= max_results:
                break
            result.append((uid, "proven"))

        # Fill remaining slots with up to 2 unproven miners
        unproven_limit = min(2, max_results - len(result))
        for uid in unproven[:unproven_limit]:
            result.append((uid, "unproven"))

        return result

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
            # Reset attestation metrics
            m.attestations_total = 0
            m.attestations_valid = 0
            m.attestation_latencies.clear()
            # Reset health checks
            m.health_checks_total = 0
            m.health_checks_responded = 0
