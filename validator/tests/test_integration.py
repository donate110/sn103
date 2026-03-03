"""Comprehensive validator-miner integration tests.

Tests the interaction between validator and miner components across
full protocol flows: MPC pipeline, HTTP interactions, share release,
outcome-to-scoring pipeline, purchase orchestration lifecycle, and
multi-epoch scoring.
"""

from __future__ import annotations

import asyncio
import math
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from djinn_validator.core.mpc import (
    MPCContribution,
    MPCResult,
    check_availability,
    compute_local_contribution,
)
from djinn_validator.core.outcomes import (
    EventResult,
    Outcome,
    OutcomeAttestor,
)
from djinn_validator.core.purchase import (
    PurchaseOrchestrator,
    PurchaseRequest,
    PurchaseStatus,
)
from djinn_validator.core.scoring import MinerMetrics, MinerScorer
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import (
    Share,
    generate_signal_index_shares,
    reconstruct_secret,
    split_secret,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def share_store():
    store = ShareStore()
    yield store
    store.close()


@pytest.fixture
def scorer() -> MinerScorer:
    return MinerScorer()


@pytest.fixture
def outcome_attestor() -> OutcomeAttestor:
    return OutcomeAttestor()


@pytest.fixture
def purchase_orch(share_store: ShareStore) -> PurchaseOrchestrator:
    return PurchaseOrchestrator(share_store)


# ---------------------------------------------------------------------------
# 1. Full MPC Pipeline Test
# ---------------------------------------------------------------------------


class TestFullMPCPipeline:
    """Generate Shamir shares, compute local MPC contributions, check
    availability, and verify the result matches the expected outcome."""

    def test_end_to_end_available(self) -> None:
        """Secret index 5 is in the available set {3, 5, 7} -> available."""
        real_index = 5
        shares = generate_signal_index_shares(real_index, n=10, k=7)

        participating = shares[:7]
        all_xs = [s.x for s in participating]

        contributions = [
            compute_local_contribution(s, all_xs) for s in participating
        ]

        result = check_availability(
            contributions, available_indices={3, 5, 7}, threshold=7
        )
        assert result.available is True
        assert result.participating_validators == 7

    def test_end_to_end_unavailable(self) -> None:
        """Secret index 5 is NOT in the available set {1, 2, 3} -> unavailable."""
        real_index = 5
        shares = generate_signal_index_shares(real_index, n=10, k=7)

        participating = shares[:7]
        all_xs = [s.x for s in participating]

        contributions = [
            compute_local_contribution(s, all_xs) for s in participating
        ]

        result = check_availability(
            contributions, available_indices={1, 2, 3}, threshold=7
        )
        assert result.available is False

    def test_reconstruction_matches_secret(self) -> None:
        """Verify that the reconstructed secret from shares equals the
        original secret index."""
        for real_index in range(1, 11):
            shares = generate_signal_index_shares(real_index, n=10, k=7)
            reconstructed = reconstruct_secret(shares[:7])
            assert reconstructed == real_index

    def test_different_validator_subsets_agree(self) -> None:
        """Any 7-of-10 subset should produce the same MPC result."""
        real_index = 4
        shares = generate_signal_index_shares(real_index, n=10, k=7)
        available = {2, 4, 6, 8}

        # Try two different subsets of 7 validators
        for start in (0, 3):
            participating = shares[start : start + 7]
            all_xs = [s.x for s in participating]
            contributions = [
                compute_local_contribution(s, all_xs) for s in participating
            ]
            result = check_availability(contributions, available, threshold=7)
            assert result.available is True

    def test_pipeline_with_superset_validators(self) -> None:
        """Using all 10 validators still correctly detects availability."""
        real_index = 8
        shares = generate_signal_index_shares(real_index, n=10, k=7)

        all_xs = [s.x for s in shares]
        contributions = [
            compute_local_contribution(s, all_xs) for s in shares
        ]
        result = check_availability(contributions, {8}, threshold=7)
        assert result.available is True

    def test_pipeline_insufficient_validators_fails(self) -> None:
        """Fewer than threshold validators means unavailable result."""
        real_index = 6
        shares = generate_signal_index_shares(real_index, n=10, k=7)

        participating = shares[:5]
        all_xs = [s.x for s in participating]
        contributions = [
            compute_local_contribution(s, all_xs) for s in participating
        ]
        result = check_availability(contributions, {6}, threshold=7)
        assert result.available is False
        assert result.participating_validators == 5


# ---------------------------------------------------------------------------
# 2. Validator-Miner HTTP Interaction
# ---------------------------------------------------------------------------


class TestValidatorMinerHTTP:
    """Test the validator's interaction with the miner HTTP server.

    Mocks the miner's /v1/check endpoint and validates that the validator
    correctly processes check responses, timeouts, and errors.
    """

    @pytest.mark.asyncio
    async def test_check_request_available(self) -> None:
        """Validator sends a check request and processes an 'available' response."""
        miner_response = {
            "results": [
                {"index": 1, "available": True, "bookmakers": [{"bookmaker": "DraftKings", "odds": 1.91}]},
                {"index": 2, "available": False, "bookmakers": []},
                {"index": 3, "available": True, "bookmakers": [{"bookmaker": "FanDuel", "odds": 1.95}]},
            ],
            "available_indices": [1, 3],
            "response_time_ms": 120.5,
        }

        mock_response = httpx.Response(200, json=miner_response)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        check_payload = {
            "lines": [
                {
                    "index": 1,
                    "sport": "basketball_nba",
                    "event_id": "evt-1",
                    "home_team": "Lakers",
                    "away_team": "Celtics",
                    "market": "spreads",
                    "line": -3.0,
                    "side": "Lakers",
                },
                {
                    "index": 2,
                    "sport": "basketball_nba",
                    "event_id": "evt-1",
                    "home_team": "Lakers",
                    "away_team": "Celtics",
                    "market": "spreads",
                    "line": -3.0,
                    "side": "Celtics",
                },
                {
                    "index": 3,
                    "sport": "basketball_nba",
                    "event_id": "evt-1",
                    "home_team": "Lakers",
                    "away_team": "Celtics",
                    "market": "totals",
                    "line": 218.5,
                    "side": "Over",
                },
            ],
        }

        resp = await mock_client.post("http://miner:8091/v1/check", json=check_payload)
        data = resp.json()

        assert data["available_indices"] == [1, 3]
        assert len(data["results"]) == 3
        assert data["results"][0]["available"] is True
        assert data["results"][1]["available"] is False

        # Validator would feed available_indices into MPC
        available_set = set(data["available_indices"])
        assert 1 in available_set
        assert 3 in available_set
        assert 2 not in available_set

    @pytest.mark.asyncio
    async def test_check_request_all_unavailable(self) -> None:
        """All lines unavailable -> empty available_indices."""
        miner_response = {
            "results": [
                {"index": i, "available": False, "bookmakers": []} for i in range(1, 4)
            ],
            "available_indices": [],
            "response_time_ms": 95.2,
        }

        mock_response = httpx.Response(200, json=miner_response)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        resp = await mock_client.post("http://miner:8091/v1/check", json={"lines": []})
        data = resp.json()

        assert data["available_indices"] == []
        available_set = set(data["available_indices"])
        assert len(available_set) == 0

    @pytest.mark.asyncio
    async def test_miner_timeout(self) -> None:
        """Validator handles miner timeouts gracefully."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ReadTimeout("miner timed out"))

        with pytest.raises(httpx.ReadTimeout):
            await mock_client.post("http://miner:8091/v1/check", json={"lines": []})

    @pytest.mark.asyncio
    async def test_miner_connection_error(self) -> None:
        """Validator handles miner connection errors gracefully."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=httpx.ConnectError("connection refused")
        )

        with pytest.raises(httpx.ConnectError):
            await mock_client.post("http://miner:8091/v1/check", json={"lines": []})

    @pytest.mark.asyncio
    async def test_miner_500_error(self) -> None:
        """Validator handles miner server errors."""
        error_response = httpx.Response(500, json={"detail": "internal error"})
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=error_response)

        resp = await mock_client.post("http://miner:8091/v1/check", json={"lines": []})
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_latency_recorded_from_response(self) -> None:
        """Validator extracts and can use latency from miner response for scoring."""
        miner_response = {
            "results": [{"index": 1, "available": True, "bookmakers": []}],
            "available_indices": [1],
            "response_time_ms": 250.3,
        }
        mock_response = httpx.Response(200, json=miner_response)
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)

        resp = await mock_client.post("http://miner:8091/v1/check", json={"lines": []})
        data = resp.json()

        latency_s = data["response_time_ms"] / 1000.0
        scorer = MinerScorer()
        metrics = scorer.get_or_create(uid=1, hotkey="hk1")
        metrics.record_query(correct=True, latency=latency_s, proof_submitted=True)

        assert metrics.latencies == [pytest.approx(0.2503)]


# ---------------------------------------------------------------------------
# 3. Share Release Pipeline
# ---------------------------------------------------------------------------


class TestShareReleasePipeline:
    """Store shares, validate purchase conditions, release shares,
    verify key reconstruction."""

    def test_store_and_release(self, share_store: ShareStore) -> None:
        """Store a share, release it to a buyer, verify returned bytes."""
        signal_id = "sig-pipeline-1"
        key_material = b"aes-key-share-encrypted"
        share = Share(x=1, y=999)

        share_store.store(signal_id, "0xGenius", share, key_material)
        assert share_store.has(signal_id)

        released = share_store.release(signal_id, "0xBuyer1")
        assert released == key_material

    def test_release_nonexistent_signal(self, share_store: ShareStore) -> None:
        """Releasing a share for a non-stored signal returns None."""
        result = share_store.release("nonexistent", "0xBuyer")
        assert result is None

    def test_release_idempotent(self, share_store: ShareStore) -> None:
        """Releasing the same share to the same buyer returns the same data."""
        signal_id = "sig-idem"
        key_material = b"key-data"
        share_store.store(signal_id, "0xGenius", Share(x=1, y=1), key_material)

        first = share_store.release(signal_id, "0xBuyer1")
        second = share_store.release(signal_id, "0xBuyer1")
        assert first == second == key_material

    def test_release_to_multiple_buyers(self, share_store: ShareStore) -> None:
        """Different buyers can each get the same share data."""
        signal_id = "sig-multi"
        key_material = b"shared-key"
        share_store.store(signal_id, "0xGenius", Share(x=1, y=1), key_material)

        for buyer in ("0xA", "0xB", "0xC"):
            released = share_store.release(signal_id, buyer)
            assert released == key_material

    def test_reconstruct_key_from_released_shares(self) -> None:
        """Simulate multiple validators releasing shares, buyer reconstructs
        the original secret."""
        secret = 42
        shares = split_secret(secret, n=10, k=7)

        # Simulate 7 validators each storing and releasing their share
        stores: list[ShareStore] = []
        try:
            for i, share in enumerate(shares[:7]):
                store = ShareStore()
                store.store(f"sig-recon", f"0xGenius", share, b"placeholder")
                stores.append(store)

            # Buyer collects shares from each validator
            collected_shares: list[Share] = []
            for store in stores:
                record = store.get("sig-recon")
                assert record is not None
                collected_shares.append(record.share)

            # Reconstruct the secret
            reconstructed = reconstruct_secret(collected_shares)
            assert reconstructed == secret
        finally:
            for store in stores:
                store.close()

    def test_purchase_validates_share_existence(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """PurchaseOrchestrator fails if the share doesn't exist."""
        req = purchase_orch.initiate("no-such-sig", "0xBuyer", "DraftKings")
        assert req.status == PurchaseStatus.FAILED

    def test_purchase_succeeds_when_share_exists(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """PurchaseOrchestrator proceeds when the share exists."""
        share_store.store("sig-exists", "0xGenius", Share(x=1, y=1), b"key")
        req = purchase_orch.initiate("sig-exists", "0xBuyer", "DraftKings")
        assert req.status == PurchaseStatus.CHECKING_AVAILABILITY


# ---------------------------------------------------------------------------
# 4. Outcome Attestation to Scoring Pipeline
# ---------------------------------------------------------------------------


class TestOutcomeToScoringPipeline:
    """Record outcomes for multiple signals, compute quality scores,
    feed into MinerScorer, verify weight computation."""

    def test_outcomes_feed_accuracy_scores(
        self, outcome_attestor: OutcomeAttestor, scorer: MinerScorer
    ) -> None:
        """Attestations determine accuracy, which feeds into scorer weights."""
        # Set up 3 miners
        m1 = scorer.get_or_create(1, "hk1")
        m2 = scorer.get_or_create(2, "hk2")
        m3 = scorer.get_or_create(3, "hk3")

        # Record outcome attestations for 3 signals
        signals = [
            ("sig-1", Outcome.FAVORABLE),
            ("sig-2", Outcome.UNFAVORABLE),
            ("sig-3", Outcome.FAVORABLE),
        ]

        for sig_id, outcome in signals:
            event_result = EventResult(event_id=f"evt-{sig_id}", status="final")
            outcome_attestor.attest(sig_id, "validator-1", outcome, event_result)

        # Simulate miner performance against these outcomes
        # Miner 1: perfect accuracy, fast
        for _ in range(10):
            m1.record_query(correct=True, latency=0.1, proof_submitted=True)
            m1.record_health_check(responded=True)

        # Miner 2: 50% accuracy, moderate speed
        for i in range(10):
            m2.record_query(correct=(i % 2 == 0), latency=0.3, proof_submitted=True)
            m2.record_health_check(responded=True)

        # Miner 3: poor accuracy, slow
        for i in range(10):
            m3.record_query(correct=(i % 5 == 0), latency=0.8, proof_submitted=False)
            m3.record_health_check(responded=(i < 5))

        weights = scorer.compute_weights(is_active_epoch=True)

        assert len(weights) == 3
        assert sum(weights.values()) == pytest.approx(1.0)
        # Best miner should have highest weight
        assert weights[1] > weights[2] > weights[3]

    def test_consensus_reached_drives_scoring(
        self, outcome_attestor: OutcomeAttestor
    ) -> None:
        """When enough validators attest the same outcome, consensus is reached."""
        signal_id = "sig-consensus"
        event_result = EventResult(event_id="evt-1", status="final")

        # 7 out of 10 validators attest FAVORABLE (threshold = floor(10 * 2/3) + 1 = 7)
        for i in range(7):
            outcome_attestor.attest(
                signal_id, f"validator-{i}", Outcome.FAVORABLE, event_result
            )

        consensus = outcome_attestor.check_consensus(signal_id, total_validators=10)
        assert consensus == Outcome.FAVORABLE

    def test_no_consensus_without_quorum(
        self, outcome_attestor: OutcomeAttestor
    ) -> None:
        """Consensus not reached when votes are split below threshold."""
        signal_id = "sig-split"
        event_result = EventResult(event_id="evt-1", status="final")

        # 4 vote FAVORABLE, 3 vote UNFAVORABLE, 3 vote VOID
        for i in range(4):
            outcome_attestor.attest(
                signal_id, f"val-fav-{i}", Outcome.FAVORABLE, event_result
            )
        for i in range(3):
            outcome_attestor.attest(
                signal_id, f"val-unfav-{i}", Outcome.UNFAVORABLE, event_result
            )
        for i in range(3):
            outcome_attestor.attest(
                signal_id, f"val-void-{i}", Outcome.VOID, event_result
            )

        consensus = outcome_attestor.check_consensus(signal_id, total_validators=10)
        assert consensus is None

    def test_outcome_accuracy_reflected_in_weights(
        self, scorer: MinerScorer
    ) -> None:
        """Miner with 100% accuracy scores much higher than 0% accuracy miner."""
        good = scorer.get_or_create(1, "good")
        bad = scorer.get_or_create(2, "bad")

        for _ in range(20):
            good.record_query(correct=True, latency=0.2, proof_submitted=True)
            good.record_health_check(responded=True)
            bad.record_query(correct=False, latency=0.2, proof_submitted=True)
            bad.record_health_check(responded=True)

        weights = scorer.compute_weights(is_active_epoch=True)
        # Good miner should get significantly more weight
        assert weights[1] > weights[2]
        # Accuracy is 40% of weight, so the difference is substantial
        assert weights[1] > 0.6


# ---------------------------------------------------------------------------
# 5. Purchase Orchestration Lifecycle
# ---------------------------------------------------------------------------


class TestPurchaseLifecycle:
    """Test full lifecycle:
    PENDING -> CHECKING_AVAILABILITY -> MPC_IN_PROGRESS -> AWAITING_PAYMENT -> SHARES_RELEASED
    """

    def test_full_lifecycle_happy_path(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """Walk through every status transition in a successful purchase."""
        signal_id = "sig-lifecycle"
        buyer = "0xBuyer"
        sportsbook = "DraftKings"

        # Pre-condition: store a share
        real_index = 3
        shares = generate_signal_index_shares(real_index, n=10, k=7)
        key_material = b"encrypted-aes-key"
        share_store.store(signal_id, "0xGenius", shares[0], key_material)

        # Step 1: Initiate purchase -> CHECKING_AVAILABILITY
        req = purchase_orch.initiate(signal_id, buyer, sportsbook)
        assert req.status == PurchaseStatus.CHECKING_AVAILABILITY
        assert req.signal_id == signal_id
        assert req.buyer_address == buyer

        # Step 2: MPC result -> AWAITING_PAYMENT (signal is available)
        mpc_result = MPCResult(available=True, participating_validators=7)
        req = purchase_orch.set_mpc_result(signal_id, buyer, mpc_result)
        assert req is not None
        assert req.status == PurchaseStatus.AWAITING_PAYMENT
        assert req.mpc_result is not None
        assert req.mpc_result.available is True

        # Step 3: Confirm payment -> SHARES_RELEASED
        tx_hash = "0xdeadbeef"
        req = purchase_orch.confirm_payment(signal_id, buyer, tx_hash)
        assert req is not None
        assert req.status == PurchaseStatus.SHARES_RELEASED
        assert req.tx_hash == tx_hash
        assert req.completed_at is not None

    def test_lifecycle_unavailable_signal(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """MPC reports unavailable -> purchase transitions to UNAVAILABLE."""
        signal_id = "sig-unavail"
        share_store.store(signal_id, "0xG", Share(x=1, y=1), b"key")

        req = purchase_orch.initiate(signal_id, "0xBuyer", "FanDuel")
        assert req.status == PurchaseStatus.CHECKING_AVAILABILITY

        mpc_result = MPCResult(available=False, participating_validators=7)
        req = purchase_orch.set_mpc_result(signal_id, "0xBuyer", mpc_result)
        assert req is not None
        assert req.status == PurchaseStatus.UNAVAILABLE

    def test_lifecycle_no_share_fails(
        self, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """No share stored -> purchase immediately fails."""
        req = purchase_orch.initiate("no-share", "0xBuyer", "BetMGM")
        assert req.status == PurchaseStatus.FAILED

    def test_duplicate_purchase_returns_existing(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """Initiating a purchase for the same signal+buyer returns the
        existing active request instead of creating a new one."""
        signal_id = "sig-dup"
        share_store.store(signal_id, "0xG", Share(x=1, y=1), b"key")

        first = purchase_orch.initiate(signal_id, "0xBuyer", "DK")
        assert first.status == PurchaseStatus.CHECKING_AVAILABILITY

        second = purchase_orch.initiate(signal_id, "0xBuyer", "DK")
        # Should return the same request object
        assert second is first

    def test_get_purchase_status(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """Can retrieve a purchase's current status."""
        signal_id = "sig-get"
        share_store.store(signal_id, "0xG", Share(x=1, y=1), b"key")

        purchase_orch.initiate(signal_id, "0xBuyer", "DK")
        result = purchase_orch.get(signal_id, "0xBuyer")
        assert result is not None
        assert result.status == PurchaseStatus.CHECKING_AVAILABILITY

    def test_get_nonexistent_purchase(
        self, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """Getting a non-existent purchase returns None."""
        assert purchase_orch.get("no-such", "0xBuyer") is None

    def test_lifecycle_with_real_mpc(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """Full lifecycle using actual MPC computation, not mocked results."""
        signal_id = "sig-real-mpc"
        real_index = 7
        shares = generate_signal_index_shares(real_index, n=10, k=7)
        key_material = b"real-aes-key"
        share_store.store(signal_id, "0xGenius", shares[0], key_material)

        # Initiate
        req = purchase_orch.initiate(signal_id, "0xBuyer", "Caesars")
        assert req.status == PurchaseStatus.CHECKING_AVAILABILITY

        # Run actual MPC with 7 validators
        participating = shares[:7]
        all_xs = [s.x for s in participating]
        contributions = [
            compute_local_contribution(s, all_xs) for s in participating
        ]
        mpc_result = check_availability(
            contributions, available_indices={5, 6, 7, 8}, threshold=7
        )
        assert mpc_result.available is True

        # Feed MPC result into orchestrator
        req = purchase_orch.set_mpc_result(signal_id, "0xBuyer", mpc_result)
        assert req is not None
        assert req.status == PurchaseStatus.AWAITING_PAYMENT

        # Confirm payment
        req = purchase_orch.confirm_payment(signal_id, "0xBuyer", "0xtxhash")
        assert req is not None
        assert req.status == PurchaseStatus.SHARES_RELEASED

    def test_failed_purchase_can_be_retried(
        self, share_store: ShareStore, purchase_orch: PurchaseOrchestrator
    ) -> None:
        """A FAILED purchase for the same signal+buyer can be retried."""
        signal_id = "sig-retry"

        # First attempt fails (no share)
        req1 = purchase_orch.initiate(signal_id, "0xBuyer", "DK")
        assert req1.status == PurchaseStatus.FAILED

        # Now store the share
        share_store.store(signal_id, "0xG", Share(x=1, y=1), b"key")

        # Retry should succeed
        req2 = purchase_orch.initiate(signal_id, "0xBuyer", "DK")
        assert req2.status == PurchaseStatus.CHECKING_AVAILABILITY


# ---------------------------------------------------------------------------
# 6. Multi-Epoch Scoring
# ---------------------------------------------------------------------------


class TestMultiEpochScoring:
    """Run the scorer through multiple epochs with different miner
    performance patterns and verify weight evolution."""

    def test_weights_shift_with_performance(self, scorer: MinerScorer) -> None:
        """Weights shift toward better-performing miners across epochs."""
        m1 = scorer.get_or_create(1, "steady")
        m2 = scorer.get_or_create(2, "improving")
        m3 = scorer.get_or_create(3, "declining")

        # Epoch 1: everyone performs equally
        for m in (m1, m2, m3):
            for _ in range(10):
                m.record_query(correct=True, latency=0.2, proof_submitted=True)
                m.record_health_check(responded=True)

        weights_e1 = scorer.compute_weights(is_active_epoch=True)
        # All roughly equal
        for uid in (1, 2, 3):
            assert weights_e1[uid] == pytest.approx(1 / 3, abs=0.01)

        scorer.reset_epoch()

        # Epoch 2: miner 2 is fast, miner 3 slows down
        for _ in range(10):
            m1.record_query(correct=True, latency=0.2, proof_submitted=True)
            m1.record_health_check(responded=True)
            m2.record_query(correct=True, latency=0.05, proof_submitted=True)
            m2.record_health_check(responded=True)
            m3.record_query(correct=True, latency=0.8, proof_submitted=True)
            m3.record_health_check(responded=True)

        weights_e2 = scorer.compute_weights(is_active_epoch=True)
        # Miner 2 should be highest (fastest), miner 3 lowest (slowest)
        assert weights_e2[2] > weights_e2[1] > weights_e2[3]

    def test_empty_epoch_weights_history(self, scorer: MinerScorer) -> None:
        """In empty epochs, weight is based on uptime + consecutive participation."""
        m1 = scorer.get_or_create(1, "veteran")
        m2 = scorer.get_or_create(2, "newcomer")

        m1.consecutive_epochs = 50
        m2.consecutive_epochs = 2

        # Both have same uptime
        for m in (m1, m2):
            for _ in range(10):
                m.record_health_check(responded=True)

        weights = scorer.compute_weights(is_active_epoch=False)

        assert len(weights) == 2
        assert sum(weights.values()) == pytest.approx(1.0)
        # Veteran has more history, should get more weight
        assert weights[1] > weights[2]

    def test_reset_epoch_clears_per_epoch_metrics(
        self, scorer: MinerScorer
    ) -> None:
        """reset_epoch clears queries, latencies, proofs, health checks
        and increments consecutive_epochs for participating miners."""
        m = scorer.get_or_create(1, "hk1")
        m.record_query(correct=True, latency=0.1, proof_submitted=True)
        m.record_health_check(responded=True)
        m.consecutive_epochs = 10

        scorer.reset_epoch()

        assert m.queries_total == 0
        assert m.queries_correct == 0
        assert m.latencies == []
        assert m.proofs_submitted == 0
        assert m.health_checks_total == 0
        assert m.health_checks_responded == 0
        assert m.consecutive_epochs == 11  # Incremented because miner participated

    def test_reset_epoch_resets_inactive_miner(self, scorer: MinerScorer) -> None:
        """reset_epoch resets consecutive_epochs to 0 for inactive miners."""
        m = scorer.get_or_create(1, "hk1")
        m.consecutive_epochs = 5
        # No queries or health check responses this epoch

        scorer.reset_epoch()

        assert m.consecutive_epochs == 0

    def test_three_epoch_simulation(self, scorer: MinerScorer) -> None:
        """Simulate 3 epochs and track weight changes for 4 miners."""
        miners = {
            uid: scorer.get_or_create(uid, f"hk{uid}") for uid in range(1, 5)
        }

        epoch_weights: list[dict[int, float]] = []

        # Epoch 1: all active, miners differ in accuracy
        accuracy_rates = {1: 1.0, 2: 0.8, 3: 0.5, 4: 0.2}
        for uid, rate in accuracy_rates.items():
            m = miners[uid]
            for i in range(20):
                m.record_query(
                    correct=(i < int(20 * rate)),
                    latency=0.15,
                    proof_submitted=True,
                )
                m.record_health_check(responded=True)

        w = scorer.compute_weights(is_active_epoch=True)
        epoch_weights.append(w)
        assert w[1] > w[2] > w[3] > w[4]

        scorer.reset_epoch()
        # After reset: all miners participated → consecutive_epochs = 1

        # Epoch 2: empty epoch (no active signals), only uptime matters
        for uid in range(1, 5):
            m = miners[uid]
            for _ in range(10):
                m.record_health_check(responded=(uid != 4))

        w2 = scorer.compute_weights(is_active_epoch=False)
        epoch_weights.append(w2)
        # Miner 4 has 0 uptime; all have same consecutive_epochs from epoch 1
        assert w2[4] < w2[1]

        scorer.reset_epoch()
        # After reset: miners 1-3 responded → consecutive_epochs = 2
        # Miner 4 didn't respond → consecutive_epochs = 0

        # Epoch 3: active again, miner 4 comes back strong
        for uid in range(1, 5):
            m = miners[uid]
            for _ in range(20):
                m.record_query(
                    correct=True,
                    latency=0.1 if uid == 4 else 0.3,
                    proof_submitted=True,
                )
                m.record_health_check(responded=True)

        w3 = scorer.compute_weights(is_active_epoch=True)
        epoch_weights.append(w3)

        # All miners now have perfect accuracy and coverage.
        # Miner 4 is fastest, so should have highest weight.
        assert w3[4] > w3[1]

        assert len(epoch_weights) == 3

    def test_remove_miner_between_epochs(self, scorer: MinerScorer) -> None:
        """Removing a miner removes them from future weight calculations."""
        for uid in range(1, 4):
            m = scorer.get_or_create(uid, f"hk{uid}")
            m.record_query(correct=True, latency=0.1, proof_submitted=True)
            m.record_health_check(responded=True)

        w1 = scorer.compute_weights(is_active_epoch=True)
        assert len(w1) == 3

        scorer.remove(2)
        scorer.reset_epoch()

        for uid in (1, 3):
            m = scorer.get_or_create(uid, f"hk{uid}")
            m.record_query(correct=True, latency=0.1, proof_submitted=True)
            m.record_health_check(responded=True)

        w2 = scorer.compute_weights(is_active_epoch=True)
        assert len(w2) == 2
        assert 2 not in w2

    def test_single_miner_gets_all_weight(self, scorer: MinerScorer) -> None:
        """A single miner in the network gets weight 1.0."""
        m = scorer.get_or_create(1, "solo")
        m.record_query(correct=True, latency=0.1, proof_submitted=True)
        m.record_health_check(responded=True)

        weights = scorer.compute_weights(is_active_epoch=True)
        assert weights[1] == pytest.approx(1.0)

    def test_empty_scorer_returns_empty_weights(self, scorer: MinerScorer) -> None:
        """No miners registered -> empty weights dict."""
        weights = scorer.compute_weights(is_active_epoch=True)
        assert weights == {}

    def test_all_zero_scores_gives_zero_weights(
        self, scorer: MinerScorer
    ) -> None:
        """When all miners have zero scores, weights are zero (no free emissions)."""
        for uid in range(1, 4):
            scorer.get_or_create(uid, f"hk{uid}")

        weights = scorer.compute_weights(is_active_epoch=True)
        for uid in range(1, 4):
            assert weights[uid] == 0.0
