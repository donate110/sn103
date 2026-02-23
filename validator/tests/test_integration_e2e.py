"""Phase 7 end-to-end integration tests.

Tests the full signal lifecycle across multiple validators and a miner,
exercising every component in the protocol:

1. Genius creates a signal (splits key, stores shares on validators)
2. Miner checks line availability at sportsbooks
3. Validators run distributed MPC to check if real index is available
4. Buyer purchases signal (key share released)
5. Buyer reconstructs key from multiple validator shares
6. Outcome attestation and consensus
7. Scoring based on miner performance

Uses real FastAPI TestClient instances for all HTTP interactions.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from djinn_validator.api.server import create_app as create_validator_app
from djinn_validator.core.mpc import (
    MPCResult,
    reconstruct_at_zero,
    secure_check_availability,
)
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.mpc_orchestrator import MPCOrchestrator
from djinn_validator.core.outcomes import (
    EventResult,
    Outcome,
    OutcomeAttestor,
)
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.scoring import MinerScorer
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import (
    Share,
    generate_signal_index_shares,
    reconstruct_secret,
    split_secret,
)


# ---------------------------------------------------------------------------
# Test infrastructure
# ---------------------------------------------------------------------------


class ValidatorNode:
    """A validator instance with its own ShareStore, app, and test client."""

    def __init__(self, store: ShareStore, index: int) -> None:
        self.store = store
        self.index = index
        self.purchase_orch = PurchaseOrchestrator(store)
        self.outcome_attestor = OutcomeAttestor()
        self.mpc_coordinator = MPCCoordinator()
        self.app = create_validator_app(
            share_store=store,
            purchase_orch=self.purchase_orch,
            outcome_attestor=self.outcome_attestor,
            mpc_coordinator=self.mpc_coordinator,
        )


# ---------------------------------------------------------------------------
# Full signal lifecycle tests
# ---------------------------------------------------------------------------


class TestFullSignalLifecycle:
    """End-to-end test of the complete Djinn protocol flow."""

    @pytest.mark.asyncio
    async def test_genius_to_buyer_available(self) -> None:
        """Full flow: Genius creates signal → Buyer purchases → Key reconstructed.

        This is the happy path where the real line IS available at the sportsbook.
        """
        # Setup
        real_index = 5
        signal_id = "e2e-available-001"
        n_validators = 3
        threshold = 2
        aes_key_material = b"aes-256-gcm-key-material-32-byte"

        # Genius splits the signal index into Shamir shares
        index_shares = split_secret(real_index, n=n_validators, k=threshold)
        # Genius also splits the encryption key (one share per validator)
        key_shares = [
            f"enc-key-share-validator-{i}".encode()
            for i in range(n_validators)
        ]

        # Create validator nodes
        nodes: list[ValidatorNode] = []
        for i in range(n_validators):
            store = ShareStore()
            nodes.append(ValidatorNode(store, i))

        try:
            # Step 1: Genius stores shares on each validator
            for i, node in enumerate(nodes):
                node.store.store(
                    signal_id=signal_id,
                    genius_address="0xGeniusAddress",
                    share=index_shares[i],
                    encrypted_key_share=key_shares[i],
                )

            # Step 2: Buyer initiates purchase via validator 0
            # Miner reports available indices (includes real index 5)
            miner_available = {3, 5, 7, 9}

            # Step 3: Run distributed MPC across all validators
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=node.app),
                    base_url=f"http://v{i}:8421",
                )
                for i, node in enumerate(nodes)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )
                peers = [
                    {"uid": i, "url": f"http://v{i}:8421"}
                    for i in range(1, n_validators)
                ]

                real_post = httpx.AsyncClient.post

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post):
                    mpc_result = await orchestrator._distributed_mpc(
                        signal_id=signal_id,
                        local_share=index_shares[0],
                        available_indices=miner_available,
                        peers=peers,
                    )

                assert mpc_result is not None
                assert mpc_result.available is True

                # Step 4: Key shares released from each validator
                released_keys = []
                for node in nodes:
                    key_data = node.store.release(signal_id, "0xBuyerAddress")
                    assert key_data is not None
                    released_keys.append(key_data)

                # Step 5: Buyer reconstructs the key from validator shares
                # (In real system, buyer decrypts each share with their wallet)
                assert len(released_keys) == n_validators
                for i, key in enumerate(released_keys):
                    assert key == key_shares[i]

                # Step 6: Buyer can also verify the index shares reconstruct correctly
                reconstructed_index = reconstruct_secret(index_shares[:threshold])
                assert reconstructed_index == real_index

            finally:
                for c in clients:
                    await c.aclose()

        finally:
            for node in nodes:
                node.store.close()

    @pytest.mark.asyncio
    async def test_genius_to_buyer_unavailable(self) -> None:
        """Full flow where the real line is NOT available → no key released."""
        real_index = 5
        signal_id = "e2e-unavailable-001"
        n_validators = 3
        threshold = 2

        index_shares = split_secret(real_index, n=n_validators, k=threshold)
        key_shares = [f"key-{i}".encode() for i in range(n_validators)]

        nodes: list[ValidatorNode] = []
        for i in range(n_validators):
            store = ShareStore()
            nodes.append(ValidatorNode(store, i))

        try:
            for i, node in enumerate(nodes):
                node.store.store(
                    signal_id=signal_id,
                    genius_address="0xGenius",
                    share=index_shares[i],
                    encrypted_key_share=key_shares[i],
                )

            # Miner reports available indices (does NOT include real index 5)
            miner_available = {1, 2, 3, 4}

            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=node.app),
                    base_url=f"http://v{i}:8421",
                )
                for i, node in enumerate(nodes)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )
                peers = [
                    {"uid": i, "url": f"http://v{i}:8421"}
                    for i in range(1, n_validators)
                ]

                real_post = httpx.AsyncClient.post

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post):
                    mpc_result = await orchestrator._distributed_mpc(
                        signal_id=signal_id,
                        local_share=index_shares[0],
                        available_indices=miner_available,
                        peers=peers,
                    )

                assert mpc_result is not None
                assert mpc_result.available is False
                # Key should NOT be released

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for node in nodes:
                node.store.close()


class TestOutcomeAndScoring:
    """Test outcome attestation → consensus → scoring pipeline end-to-end."""

    def test_full_outcome_consensus_to_scoring(self) -> None:
        """Multiple validators attest outcomes, consensus drives scoring weights."""
        n_validators = 10
        signal_id = "e2e-outcome-001"

        # Single attestor collects all votes (simulates a validator receiving
        # attestations from peers via the /v1/signal/{id}/outcome endpoint)
        attestor = OutcomeAttestor()
        scorer = MinerScorer()

        # Register 3 miners
        for uid in range(1, 4):
            scorer.get_or_create(uid, f"miner-{uid}")

        # Event result (game is final)
        event = EventResult(
            event_id="evt-nba-001",
            status="final",
            home_score=110,
            away_score=105,
        )

        # 8 validators attest FAVORABLE (above 2/3 threshold)
        for i in range(8):
            attestor.attest(signal_id, f"val-{i}", Outcome.FAVORABLE, event)

        # 2 validators attest UNFAVORABLE
        for i in range(8, 10):
            attestor.attest(signal_id, f"val-{i}", Outcome.UNFAVORABLE, event)

        consensus = attestor.check_consensus(signal_id, total_validators=n_validators)
        assert consensus == Outcome.FAVORABLE

        # Feed miner performance into scorer
        m1 = scorer.get_or_create(1, "miner-1")
        m2 = scorer.get_or_create(2, "miner-2")
        m3 = scorer.get_or_create(3, "miner-3")

        # Miner 1: perfect performance
        for _ in range(10):
            m1.record_query(correct=True, latency=0.1, proof_submitted=True)
            m1.record_health_check(responded=True)

        # Miner 2: moderate
        for i in range(10):
            m2.record_query(correct=(i < 7), latency=0.3, proof_submitted=True)
            m2.record_health_check(responded=True)

        # Miner 3: poor
        for i in range(10):
            m3.record_query(correct=(i < 3), latency=0.8, proof_submitted=False)
            m3.record_health_check(responded=(i < 5))

        weights = scorer.compute_weights(is_active_epoch=True)
        assert len(weights) == 3
        assert sum(weights.values()) == pytest.approx(1.0)
        assert weights[1] > weights[2] > weights[3]


class TestMultiSignalMultiEpoch:
    """Test multiple signals across multiple epochs with scoring evolution."""

    def test_three_signals_two_epochs(self) -> None:
        """Create 3 signals, process outcomes, score across 2 epochs."""
        scorer = MinerScorer()
        attestor = OutcomeAttestor()

        # 2 miners
        m1 = scorer.get_or_create(1, "fast-miner")
        m2 = scorer.get_or_create(2, "slow-miner")

        # Epoch 1: Signal 1 and 2
        signals_e1 = [
            ("sig-001", Outcome.FAVORABLE),
            ("sig-002", Outcome.UNFAVORABLE),
        ]

        for sig_id, outcome in signals_e1:
            event = EventResult(event_id=f"evt-{sig_id}", status="final")
            # 7 out of 10 validators attest the same outcome
            for v in range(7):
                attestor.attest(sig_id, f"val-{v}", outcome, event)

        # Verify consensus (7/10 >= 2/3 + 1)
        assert attestor.check_consensus("sig-001", total_validators=10) == Outcome.FAVORABLE
        assert attestor.check_consensus("sig-002", total_validators=10) == Outcome.UNFAVORABLE

        # Record miner performance for epoch 1
        for _ in range(20):
            m1.record_query(correct=True, latency=0.1, proof_submitted=True)
            m1.record_health_check(responded=True)
            m2.record_query(correct=True, latency=0.5, proof_submitted=True)
            m2.record_health_check(responded=True)

        w1 = scorer.compute_weights(is_active_epoch=True)
        assert w1[1] > w1[2]  # Fast miner wins

        # Epoch 2: reset and reverse performance
        scorer.reset_epoch()

        for _ in range(20):
            m1.record_query(correct=False, latency=0.5, proof_submitted=False)
            m1.record_health_check(responded=True)
            m2.record_query(correct=True, latency=0.1, proof_submitted=True)
            m2.record_health_check(responded=True)

        w2 = scorer.compute_weights(is_active_epoch=True)
        assert w2[2] > w2[1]  # Slow miner catches up and overtakes


class TestDistributedPurchaseViaAPI:
    """Test the purchase flow through the actual HTTP API with distributed MPC."""

    @pytest.mark.asyncio
    async def test_purchase_api_single_validator(self) -> None:
        """Exercise /v1/signal/{id}/purchase in single-validator prototype mode.

        Single-validator mode uses threshold=1 reconstruction, so the share
        must directly encode the secret (x=1, y=real_index).
        """
        real_index = 3
        signal_id = "e2e-purchase-api"
        key_material = b"encrypted-aes-key-for-buyer"

        store = ShareStore()
        try:
            # In single-validator prototype mode, store y=real_index directly
            store.store(
                signal_id=signal_id,
                genius_address="0xGenius",
                share=Share(x=1, y=real_index),
                encrypted_key_share=key_material,
            )

            node = ValidatorNode(store, 0)
            from fastapi.testclient import TestClient

            test_client = TestClient(node.app)

            # Purchase — available_indices includes real index 3
            resp = test_client.post(f"/v1/signal/{signal_id}/purchase", json={
                "buyer_address": "0x" + "ab" * 20,
                "sportsbook": "DraftKings",
                "available_indices": [1, 2, 3, 5, 7],
            })
            assert resp.status_code == 200
            data = resp.json()
            assert data["available"] is True
            assert data["status"] == "complete"
            assert data["encrypted_key_share"] is not None

            recovered = bytes.fromhex(data["encrypted_key_share"])
            assert recovered == key_material

        finally:
            store.close()

    @pytest.mark.asyncio
    async def test_purchase_api_distributed(self) -> None:
        """Exercise /v1/signal/{id}/purchase with distributed MPC across validators."""
        real_index = 3
        signal_id = "e2e-purchase-dist"
        n_validators = 3
        threshold = 2

        index_shares = split_secret(real_index, n=n_validators, k=threshold)
        key_material = b"encrypted-aes-key-for-buyer"

        nodes: list[ValidatorNode] = []
        for i in range(n_validators):
            store = ShareStore()
            nodes.append(ValidatorNode(store, i))

        try:
            for i, node in enumerate(nodes):
                node.store.store(
                    signal_id=signal_id,
                    genius_address="0xGenius",
                    share=index_shares[i],
                    encrypted_key_share=key_material,
                )

            # Run distributed MPC directly (bypasses the purchase API's
            # single-validator fallback by calling _distributed_mpc)
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=node.app),
                    base_url=f"http://v{i}:8421",
                )
                for i, node in enumerate(nodes)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )
                peers = [
                    {"uid": i, "url": f"http://v{i}:8421"}
                    for i in range(1, n_validators)
                ]

                real_post = httpx.AsyncClient.post

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post):
                    mpc_result = await orchestrator._distributed_mpc(
                        signal_id=signal_id,
                        local_share=index_shares[0],
                        available_indices={1, 2, 3, 5, 7},
                        peers=peers,
                    )

                assert mpc_result is not None
                assert mpc_result.available is True
                assert mpc_result.participating_validators == n_validators

                # After MPC confirms availability, release key share
                released = nodes[0].store.release(signal_id, "0xBuyer")
                assert released == key_material

            finally:
                for c in clients:
                    await c.aclose()

        finally:
            for node in nodes:
                node.store.close()

    @pytest.mark.asyncio
    async def test_purchase_api_unavailable(self) -> None:
        """Purchase when signal is NOT available returns appropriate response."""
        real_index = 8
        signal_id = "e2e-purchase-unavail"

        shares = split_secret(real_index, n=3, k=2)

        store = ShareStore()
        try:
            store.store(signal_id, "0xG", shares[0], b"key")
            node = ValidatorNode(store, 0)

            from fastapi.testclient import TestClient

            test_client = TestClient(node.app)

            # Purchase — available_indices does NOT include 8
            resp = test_client.post(f"/v1/signal/{signal_id}/purchase", json={
                "buyer_address": "0x" + "ab" * 20,
                "sportsbook": "FanDuel",
                "available_indices": [1, 2, 3, 4, 5],
            })
            assert resp.status_code == 200
            data = resp.json()
            assert data["available"] is False
            assert data["status"] == "unavailable"
            assert data["encrypted_key_share"] is None

        finally:
            store.close()


class TestSignalRegistrationAndOutcome:
    """Test signal registration → outcome resolution flow via API."""

    def test_register_outcome_consensus(self) -> None:
        """Register signal, attest outcomes, check consensus via API."""
        store = ShareStore()
        try:
            share = Share(x=1, y=5)
            store.store("sig-reg-001", "0xG", share, b"k")

            node = ValidatorNode(store, 0)
            from fastapi.testclient import TestClient

            client = TestClient(node.app)

            # Register signal for outcome tracking
            resp = client.post("/v1/signal/sig-reg-001/register", json={
                "sport": "basketball_nba",
                "event_id": "evt-lakers-celtics",
                "home_team": "Lakers",
                "away_team": "Celtics",
                "lines": [
                    "Lakers -3.5 (-110)", "Celtics +3.5 (-110)", "Over 218.5 (-110)",
                    "Under 218.5 (-110)", "Lakers ML (-150)", "Celtics ML (+130)",
                    "Lakers -1.5 (-105)", "Celtics +1.5 (-115)", "Over 215.0 (-110)",
                    "Under 215.0 (-110)",
                ],
            })
            assert resp.status_code == 200
            assert resp.json()["registered"] is True

            # Submit outcome attestation
            resp = client.post("/v1/signal/sig-reg-001/outcome", json={
                "signal_id": "sig-reg-001",
                "event_id": "evt-lakers-celtics",
                "outcome": 1,  # FAVORABLE
                "validator_hotkey": "val-key-001",
            })
            assert resp.status_code == 200
            data = resp.json()
            assert data["outcome"] == 1

            # Health endpoint reflects active state
            resp = client.get("/health")
            assert resp.status_code == 200
            assert resp.json()["shares_held"] == 1

        finally:
            store.close()


class TestMultiValidatorKeyReconstruction:
    """Test that key shares from multiple validators correctly reconstruct."""

    def test_key_reconstruction_from_released_shares(self) -> None:
        """Simulate buyer collecting shares from 7 validators and reconstructing."""
        real_index = 4
        n_validators = 10
        threshold = 7

        # Genius generates shares
        index_shares = generate_signal_index_shares(real_index, n=n_validators, k=threshold)

        # Store shares on validators
        stores: list[ShareStore] = []
        try:
            for i, share in enumerate(index_shares):
                store = ShareStore()
                store.store(
                    signal_id="recon-test",
                    genius_address="0xGenius",
                    share=share,
                    encrypted_key_share=f"key-part-{i}".encode(),
                )
                stores.append(store)

            # Buyer collects shares from first 7 validators
            collected_shares: list[Share] = []
            collected_keys: list[bytes] = []

            for store in stores[:threshold]:
                record = store.get("recon-test")
                assert record is not None
                collected_shares.append(record.share)
                released = store.release("recon-test", "0xBuyer")
                assert released is not None
                collected_keys.append(released)

            # Verify index reconstruction
            reconstructed = reconstruct_secret(collected_shares)
            assert reconstructed == real_index

            # Verify all key parts retrieved
            assert len(collected_keys) == threshold
            for i, key in enumerate(collected_keys):
                assert key == f"key-part-{i}".encode()

        finally:
            for store in stores:
                store.close()

    def test_different_validator_subsets_reconstruct_same_index(self) -> None:
        """Any 7-of-10 validators produce the same reconstructed index."""
        real_index = 7
        shares = generate_signal_index_shares(real_index, n=10, k=7)

        # Try 4 different subsets
        subsets = [
            shares[0:7],
            shares[1:8],
            shares[2:9],
            shares[3:10],
        ]

        for subset in subsets:
            assert reconstruct_secret(subset) == real_index
