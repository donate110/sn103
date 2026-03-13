"""Tests for the distributed MPC protocol with real HTTP round-trips.

Spins up multiple FastAPI TestClient instances (one per "validator") and
runs the full Beaver-triple MPC protocol across them, verifying that:
1. Correct results are produced for available and unavailable signals
2. The protocol works with varying numbers of participants
3. Peer failures during the protocol are handled gracefully
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from djinn_validator.api.server import create_app
from djinn_validator.core.mpc import (
    DistributedParticipantState,
    MPCResult,
    _split_secret_at_points,
    generate_beaver_triples,
    reconstruct_at_zero,
    secure_check_availability,
)
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.mpc_orchestrator import MPCOrchestrator
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import ShareStore
from djinn_validator.utils.crypto import BN254_PRIME, Share, split_secret


# ---------------------------------------------------------------------------
# DistributedParticipantState unit tests
# ---------------------------------------------------------------------------


class TestDistributedParticipantState:
    """Test the per-validator gate computation logic."""

    def _make_state(
        self,
        validator_x: int,
        secret: int,
        r_val: int,
        available: list[int],
        shares: list[Share],
        r_shares: list[Share],
        triples: list,
    ) -> DistributedParticipantState:
        """Build a DistributedParticipantState from generated crypto material."""
        a_map = {s.x: s.y for s in triples[0].a_shares}
        b_map = {s.x: s.y for s in triples[0].b_shares}
        c_map = {s.x: s.y for s in triples[0].c_shares}

        triple_a = []
        triple_b = []
        triple_c = []
        for t in triples:
            ta = {s.x: s.y for s in t.a_shares}
            tb = {s.x: s.y for s in t.b_shares}
            tc = {s.x: s.y for s in t.c_shares}
            triple_a.append(ta[validator_x])
            triple_b.append(tb[validator_x])
            triple_c.append(tc[validator_x])

        s_share = next(s for s in shares if s.x == validator_x)
        r_share = next(s for s in r_shares if s.x == validator_x)

        return DistributedParticipantState(
            validator_x=validator_x,
            secret_share_y=s_share.y,
            r_share_y=r_share.y,
            available_indices=available,
            triple_a=triple_a,
            triple_b=triple_b,
            triple_c=triple_c,
        )

    def test_single_gate_matches_centralized(self) -> None:
        """Distributed gate 0 computation matches the centralized version."""
        p = BN254_PRIME
        secret = 5
        available = [3]
        xs = [1, 2, 3]
        k = 2

        shares = _split_secret_at_points(secret, xs, k, p)
        r = 42
        r_shares = _split_secret_at_points(r, xs, k, p)
        triples = generate_beaver_triples(1, n=3, k=k, x_coords=xs)

        # Each validator computes their gate 0 contribution
        d_vals: dict[int, int] = {}
        e_vals: dict[int, int] = {}

        for vx in xs:
            state = self._make_state(vx, secret, r, available, shares, r_shares, triples)
            d_i, e_i = state.compute_gate(0)
            d_vals[vx] = d_i
            e_vals[vx] = e_i

        # Reconstruct d and e
        d = reconstruct_at_zero(d_vals, p)
        e = reconstruct_at_zero(e_vals, p)

        # The centralized version should give the same d, e
        a_map = {s.x: s.y for s in triples[0].a_shares}
        b_map = {s.x: s.y for s in triples[0].b_shares}
        s_map = {s.x: s.y for s in shares}
        r_map = {s.x: s.y for s in r_shares}

        d_centralized: dict[int, int] = {}
        e_centralized: dict[int, int] = {}
        for vx in xs:
            d_centralized[vx] = (r_map[vx] - a_map[vx]) % p
            e_centralized[vx] = (s_map[vx] - available[0] - b_map[vx]) % p

        d_c = reconstruct_at_zero(d_centralized, p)
        e_c = reconstruct_at_zero(e_centralized, p)

        assert d == d_c
        assert e == e_c

    def test_multi_gate_available(self) -> None:
        """Full distributed protocol with multiple gates produces correct result."""
        p = BN254_PRIME
        secret = 5
        available = [3, 5, 7]
        xs = [1, 2, 3]
        k = 2
        n_gates = len(available)

        shares = _split_secret_at_points(secret, xs, k, p)
        import secrets as _secrets
        r = _secrets.randbelow(p - 1) + 1
        r_shares = _split_secret_at_points(r, xs, k, p)
        triples = generate_beaver_triples(n_gates, n=3, k=k, x_coords=xs)

        # Build participant states
        states: dict[int, DistributedParticipantState] = {}
        for vx in xs:
            states[vx] = self._make_state(vx, secret, r, available, shares, r_shares, triples)

        # Run the protocol gate by gate
        prev_d = None
        prev_e = None

        for gate_idx in range(n_gates):
            d_vals: dict[int, int] = {}
            e_vals: dict[int, int] = {}

            for vx in xs:
                d_i, e_i = states[vx].compute_gate(gate_idx, prev_d, prev_e)
                d_vals[vx] = d_i
                e_vals[vx] = e_i

            prev_d = reconstruct_at_zero(d_vals, p)
            prev_e = reconstruct_at_zero(e_vals, p)

        # Compute final z_i shares
        z_vals: dict[int, int] = {}
        last = n_gates - 1
        for vx in xs:
            ts_a = states[vx].triple_a[last]
            ts_b = states[vx].triple_b[last]
            ts_c = states[vx].triple_c[last]
            z_i = (prev_d * prev_e + prev_d * ts_b + prev_e * ts_a + ts_c) % p
            z_vals[vx] = z_i

        result = reconstruct_at_zero(z_vals, p)
        # Secret 5 is in available set {3, 5, 7} -> result should be 0
        assert result == 0

    def test_multi_gate_unavailable(self) -> None:
        """Protocol correctly reports unavailable when secret not in set."""
        p = BN254_PRIME
        secret = 5
        available = [1, 2, 3]
        xs = [1, 2, 3]
        k = 2
        n_gates = len(available)

        shares = _split_secret_at_points(secret, xs, k, p)
        import secrets as _secrets
        r = _secrets.randbelow(p - 1) + 1
        r_shares = _split_secret_at_points(r, xs, k, p)
        triples = generate_beaver_triples(n_gates, n=3, k=k, x_coords=xs)

        states: dict[int, DistributedParticipantState] = {}
        for vx in xs:
            states[vx] = self._make_state(vx, secret, r, available, shares, r_shares, triples)

        prev_d = None
        prev_e = None

        for gate_idx in range(n_gates):
            d_vals: dict[int, int] = {}
            e_vals: dict[int, int] = {}

            for vx in xs:
                d_i, e_i = states[vx].compute_gate(gate_idx, prev_d, prev_e)
                d_vals[vx] = d_i
                e_vals[vx] = e_i

            prev_d = reconstruct_at_zero(d_vals, p)
            prev_e = reconstruct_at_zero(e_vals, p)

        z_vals: dict[int, int] = {}
        last = n_gates - 1
        for vx in xs:
            ts_a = states[vx].triple_a[last]
            ts_b = states[vx].triple_b[last]
            ts_c = states[vx].triple_c[last]
            z_i = (prev_d * prev_e + prev_d * ts_b + prev_e * ts_a + ts_c) % p
            z_vals[vx] = z_i

        result = reconstruct_at_zero(z_vals, p)
        # Secret 5 is NOT in {1, 2, 3} -> result should be nonzero
        assert result != 0

    def test_gate_order_enforced(self) -> None:
        """Calling gates out of order raises ValueError."""
        p = BN254_PRIME
        state = DistributedParticipantState(
            validator_x=1,
            secret_share_y=100,
            r_share_y=200,
            available_indices=[3, 5],
            triple_a=[10, 20],
            triple_b=[30, 40],
            triple_c=[50, 60],
        )
        # Gate 1 without doing gate 0 first
        with pytest.raises(ValueError, match="Expected gate 0"):
            state.compute_gate(1, 0, 0)

    def test_gate_1_requires_prev_opened(self) -> None:
        """Gate > 0 without prev opened values raises ValueError."""
        state = DistributedParticipantState(
            validator_x=1,
            secret_share_y=100,
            r_share_y=200,
            available_indices=[3, 5],
            triple_a=[10, 20],
            triple_b=[30, 40],
            triple_c=[50, 60],
        )
        state.compute_gate(0)  # Gate 0 OK
        with pytest.raises(ValueError, match="Previous gate opened values"):
            state.compute_gate(1)  # Gate 1 needs prev values


class TestReconstructAtZero:
    """Test the reconstruct_at_zero helper."""

    def test_basic_reconstruction(self) -> None:
        secret = 42
        shares = split_secret(secret, n=5, k=3)
        values = {s.x: s.y for s in shares[:3]}
        assert reconstruct_at_zero(values) == secret

    def test_all_shares(self) -> None:
        secret = 7
        shares = split_secret(secret, n=10, k=7)
        values = {s.x: s.y for s in shares}
        assert reconstruct_at_zero(values) == secret


# ---------------------------------------------------------------------------
# Multi-validator distributed MPC via HTTP
# ---------------------------------------------------------------------------


def _create_validator_app(
    share_store: ShareStore,
    mpc_coordinator: MPCCoordinator | None = None,
) -> Any:
    """Create a minimal FastAPI app for MPC testing."""
    purchase_orch = PurchaseOrchestrator(share_store)
    outcome_attestor = OutcomeAttestor()
    return create_app(
        share_store=share_store,
        purchase_orch=purchase_orch,
        outcome_attestor=outcome_attestor,
        mpc_coordinator=mpc_coordinator,
    )


class TestMultiValidatorMPC:
    """Test the distributed MPC protocol using actual HTTP round-trips
    across multiple FastAPI TestClient instances."""

    @pytest.mark.asyncio
    async def test_distributed_protocol_available(self) -> None:
        """3 validators run the full distributed MPC, secret in available set."""
        # Setup: 3 validators, each holding one Shamir share of secret=5
        secret = 5
        available = {3, 5, 7}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            # Create a ShareStore for each validator and store its share
            for i, share in enumerate(shares):
                store = ShareStore()
                store.store("sig-dist-1", "0xGenius", share, b"key-material")
                stores.append(store)

            # Create apps with TestClients
            apps = [_create_validator_app(store) for store in stores]

            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://validator{i}:8421",
                )
                for i, app in enumerate(apps)
            ]

            try:
                # The "coordinator" is validator 0
                coordinator_store = stores[0]
                coordinator_share = shares[0]
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )

                # Build fake peers (validators 1 and 2)
                peers = [
                    {"uid": i, "hotkey": f"hk{i+1}", "ip": f"validator{i}", "port": 8421,
                     "url": f"http://validator{i}:8421"}
                    for i in range(1, n_validators)
                ]

                # Monkey-patch httpx.AsyncClient to route to TestClients
                real_post = httpx.AsyncClient.post
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://validator{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://validator{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post), \
                     patch.object(httpx.AsyncClient, "get", routed_get):
                    result = await orchestrator._distributed_mpc(
                        signal_id="sig-dist-1",
                        local_share=coordinator_share,
                        available_indices=available,
                        peers=peers,
                    )

                assert result is not None
                assert result.available is True
                assert result.participating_validators == n_validators

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_distributed_protocol_unavailable(self) -> None:
        """3 validators run MPC, secret NOT in available set."""
        secret = 5
        available = {1, 2, 3}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for i, share in enumerate(shares):
                store = ShareStore()
                store.store("sig-dist-2", "0xGenius", share, b"key-material")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]

            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://validator{i}:8421",
                )
                for i, app in enumerate(apps)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )
                peers = [
                    {"uid": i, "hotkey": f"hk{i+1}", "ip": f"validator{i}", "port": 8421,
                     "url": f"http://validator{i}:8421"}
                    for i in range(1, n_validators)
                ]

                real_post = httpx.AsyncClient.post
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://validator{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://validator{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post), \
                     patch.object(httpx.AsyncClient, "get", routed_get):
                    result = await orchestrator._distributed_mpc(
                        signal_id="sig-dist-2",
                        local_share=shares[0],
                        available_indices=available,
                        peers=peers,
                    )

                assert result is not None
                assert result.available is False

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_all_ten_indices(self) -> None:
        """Test every possible secret index (1-10) against a fixed available set."""
        available = {2, 5, 8}
        n_validators = 3
        threshold = 2

        for secret in range(1, 11):
            shares = split_secret(secret, n=n_validators, k=threshold)
            stores: list[ShareStore] = []

            try:
                for share in shares:
                    store = ShareStore()
                    store.store(f"sig-idx-{secret}", "0xG", share, b"k")
                    stores.append(store)

                apps = [_create_validator_app(store) for store in stores]
                from httpx import ASGITransport

                clients = [
                    httpx.AsyncClient(
                        transport=ASGITransport(app=app),
                        base_url=f"http://v{i}:8421",
                    )
                    for i, app in enumerate(apps)
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
                    real_get = httpx.AsyncClient.get

                    async def routed_post(self_client, url, **kwargs):
                        for i, client in enumerate(clients):
                            base = f"http://v{i}:8421"
                            if url.startswith(base):
                                path = url[len(base):]
                                return await client.post(path, **kwargs)
                        return await real_post(self_client, url, **kwargs)

                    async def routed_get(self_client, url, **kwargs):
                        for i, client in enumerate(clients):
                            base = f"http://v{i}:8421"
                            if url.startswith(base):
                                path = url[len(base):]
                                return await client.get(path, **kwargs)
                        return await real_get(self_client, url, **kwargs)

                    with patch.object(httpx.AsyncClient, "post", routed_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get):
                        result = await orchestrator._distributed_mpc(
                            signal_id=f"sig-idx-{secret}",
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )

                    assert result is not None
                    expected = secret in available
                    assert result.available is expected, (
                        f"secret={secret}, expected available={expected}, got={result.available}"
                    )
                finally:
                    for c in clients:
                        await c.aclose()
            finally:
                for store in stores:
                    store.close()

    @pytest.mark.asyncio
    async def test_peer_failure_falls_back(self) -> None:
        """If a peer fails mid-protocol but we still have threshold, protocol succeeds."""
        secret = 5
        available = {3, 5}
        n_validators = 4
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-fail", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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

                call_count = 0
                real_post = httpx.AsyncClient.post
                real_get = httpx.AsyncClient.get

                async def routed_post_with_failure(self_client, url, **kwargs):
                    nonlocal call_count
                    # Make validator 3 (uid=3) fail on compute_gate
                    if "v3:8421" in url and "compute_gate" in url:
                        raise httpx.ConnectError("peer down")

                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post_with_failure), \
                     patch.object(httpx.AsyncClient, "get", routed_get):
                    result = await orchestrator._distributed_mpc(
                        signal_id="sig-fail",
                        local_share=shares[0],
                        available_indices=available,
                        peers=peers,
                    )

                # Should still succeed because we have 3 validators >= threshold 2
                assert result is not None
                assert result.available is True
                assert result.participating_validators >= threshold

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_insufficient_peers_returns_none(self) -> None:
        """If we can't reach enough peers, _distributed_mpc returns None."""
        secret = 5
        shares = split_secret(secret, n=3, k=2)

        store = ShareStore()
        try:
            store.store("sig-insuff", "0xG", shares[0], b"k")

            coordinator = MPCCoordinator()
            orchestrator = MPCOrchestrator(
                coordinator=coordinator, neuron=None, threshold=7,
            )
            peers = [
                {"uid": i, "url": f"http://v{i}:8421"}
                for i in range(1, 3)
            ]

            # All peers fail on init
            async def failing_post(self_client, url, **kwargs):
                raise httpx.ConnectError("all down")

            with patch.object(httpx.AsyncClient, "post", failing_post):
                result = await orchestrator._distributed_mpc(
                    signal_id="sig-insuff",
                    local_share=shares[0],
                    available_indices={3, 5},
                    peers=peers,
                )

            assert result is None
        finally:
            store.close()

    @pytest.mark.asyncio
    async def test_empty_available_set(self) -> None:
        """Empty available set returns unavailable immediately."""
        shares = split_secret(5, n=3, k=2)

        coordinator = MPCCoordinator()
        orchestrator = MPCOrchestrator(
            coordinator=coordinator, neuron=None, threshold=2,
        )

        result = await orchestrator._distributed_mpc(
            signal_id="sig-empty",
            local_share=shares[0],
            available_indices=set(),
            peers=[{"uid": 1, "url": "http://v1:8421"}],
        )

        assert result is not None
        assert result.available is False

    @pytest.mark.asyncio
    async def test_single_available_index(self) -> None:
        """Single available index that matches the secret."""
        secret = 7
        available = {7}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-single", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post), \
                     patch.object(httpx.AsyncClient, "get", routed_get):
                    result = await orchestrator._distributed_mpc(
                        signal_id="sig-single",
                        local_share=shares[0],
                        available_indices=available,
                        peers=peers,
                    )

                assert result is not None
                assert result.available is True

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_distributed_matches_centralized(self) -> None:
        """Distributed result matches the centralized secure_check_availability."""
        secret = 4
        available = {2, 4, 6, 8}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        # Centralized result
        centralized = secure_check_availability(shares, available, threshold)

        # Distributed result
        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-match", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                with patch.object(httpx.AsyncClient, "post", routed_post), \
                     patch.object(httpx.AsyncClient, "get", routed_get):
                    distributed = await orchestrator._distributed_mpc(
                        signal_id="sig-match",
                        local_share=shares[0],
                        available_indices=available,
                        peers=peers,
                    )

                assert distributed is not None
                assert distributed.available == centralized.available

            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()


# ---------------------------------------------------------------------------
# API endpoint tests for compute_gate
# ---------------------------------------------------------------------------


class TestComputeGateEndpoint:
    """Test the /v1/mpc/compute_gate API endpoint."""

    @pytest.mark.asyncio
    async def test_compute_gate_no_session(self) -> None:
        """Returns 404 when no participant state exists for session."""
        store = ShareStore()
        try:
            app = _create_validator_app(store)
            from httpx import ASGITransport

            async with httpx.AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post("/v1/mpc/compute_gate", json={
                    "session_id": "nonexistent",
                    "gate_idx": 0,
                })
                assert resp.status_code == 404
        finally:
            store.close()

    @pytest.mark.asyncio
    async def test_compute_gate_after_init(self) -> None:
        """After /v1/mpc/init with r_share, compute_gate returns valid values."""
        store = ShareStore()
        try:
            share = Share(x=2, y=12345)
            store.store("sig-gate", "0xG", share, b"k")
            app = _create_validator_app(store)

            from httpx import ASGITransport

            async with httpx.AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                # Init the session
                resp = await client.post("/v1/mpc/init", json={
                    "session_id": "mpc-gate-test",
                    "signal_id": "sig-gate",
                    "available_indices": [3, 5],
                    "coordinator_x": 1,
                    "participant_xs": [1, 2],
                    "threshold": 2,
                    "triple_shares": [
                        {"a": hex(100), "b": hex(200), "c": hex(20000)},
                        {"a": hex(300), "b": hex(400), "c": hex(120000)},
                    ],
                    "r_share_y": hex(9999),
                })
                assert resp.status_code == 200
                assert resp.json()["accepted"] is True

                # Compute gate 0
                resp = await client.post("/v1/mpc/compute_gate", json={
                    "session_id": "mpc-gate-test",
                    "gate_idx": 0,
                })
                assert resp.status_code == 200
                data = resp.json()
                assert "d_value" in data
                assert "e_value" in data
                assert data["gate_idx"] == 0

        finally:
            store.close()


# ---------------------------------------------------------------------------
# Authenticated MPC (SPDZ) integration tests
# ---------------------------------------------------------------------------


class TestAuthenticatedDistributedMPC:
    """Tests for the SPDZ-authenticated distributed MPC flow."""

    @pytest.mark.asyncio
    async def test_authenticated_session_creation(self) -> None:
        """Coordinator creates an authenticated MPC session."""
        coordinator = MPCCoordinator()
        xs = [1, 2, 3]
        session = coordinator.create_session(
            signal_id="sig-auth-1",
            available_indices=[3, 5],
            coordinator_x=1,
            participant_xs=xs,
            threshold=2,
            use_authenticated=True,
        )
        assert session.is_authenticated
        assert len(session.authenticated_triples) > 0
        assert len(session.mac_key_shares) == 3
        assert session.mac_alpha != 0

    @pytest.mark.asyncio
    async def test_authenticated_triple_shares_extraction(self) -> None:
        """Can extract authenticated triple shares per participant."""
        coordinator = MPCCoordinator()
        xs = [1, 2, 3]
        session = coordinator.create_session(
            signal_id="sig-auth-2",
            available_indices=[3],
            coordinator_x=1,
            participant_xs=xs,
            threshold=2,
            use_authenticated=True,
        )
        for x in xs:
            shares = coordinator.get_authenticated_triple_shares(session.session_id, x)
            assert shares is not None
            assert len(shares) > 0
            for ts in shares:
                assert "a" in ts and "y" in ts["a"] and "mac" in ts["a"]
                assert "b" in ts and "y" in ts["b"] and "mac" in ts["b"]
                assert "c" in ts and "y" in ts["c"] and "mac" in ts["c"]

    @pytest.mark.asyncio
    async def test_authenticated_mac_key_shares(self) -> None:
        """MAC key shares are retrievable for each participant."""
        coordinator = MPCCoordinator()
        xs = [1, 2, 3]
        session = coordinator.create_session(
            signal_id="sig-auth-3",
            available_indices=[3],
            coordinator_x=1,
            participant_xs=xs,
            threshold=2,
            use_authenticated=True,
        )
        for x in xs:
            mk = coordinator.get_mac_key_share(session.session_id, x)
            assert mk is not None
            assert mk.x == x
            assert mk.alpha_share != 0

    @pytest.mark.asyncio
    async def test_authenticated_distributed_available(self) -> None:
        """Authenticated distributed MPC: secret IS in available set."""
        secret = 5
        available = {3, 5, 7}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-auth-avail", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                # Force authenticated mode via env
                import os
                old_val = os.environ.get("USE_AUTHENTICATED_MPC")
                os.environ["USE_AUTHENTICATED_MPC"] = "true"
                try:
                    with patch.object(httpx.AsyncClient, "post", routed_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get):
                        result = await orchestrator._distributed_mpc(
                            signal_id="sig-auth-avail",
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )
                finally:
                    if old_val is None:
                        os.environ.pop("USE_AUTHENTICATED_MPC", None)
                    else:
                        os.environ["USE_AUTHENTICATED_MPC"] = old_val

                # Authenticated mode is intentionally disabled (coordinator
                # must not reconstruct secret). Expect None return.
                assert result is None
            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_authenticated_distributed_unavailable(self) -> None:
        """Authenticated distributed MPC: secret NOT in available set."""
        secret = 5
        available = {1, 2, 3}
        n_validators = 3
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-auth-unavail", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            from httpx import ASGITransport

            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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
                real_get = httpx.AsyncClient.get

                async def routed_post(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                async def routed_get(self_client, url, **kwargs):
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.get(path, **kwargs)
                    return await real_get(self_client, url, **kwargs)

                import os
                old_val = os.environ.get("USE_AUTHENTICATED_MPC")
                os.environ["USE_AUTHENTICATED_MPC"] = "true"
                try:
                    with patch.object(httpx.AsyncClient, "post", routed_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get):
                        result = await orchestrator._distributed_mpc(
                            signal_id="sig-auth-unavail",
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )
                finally:
                    if old_val is None:
                        os.environ.pop("USE_AUTHENTICATED_MPC", None)
                    else:
                        os.environ["USE_AUTHENTICATED_MPC"] = old_val

                # Authenticated mode is intentionally disabled
                assert result is None
            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()


# ---------------------------------------------------------------------------
# Network OT distributed triple generation tests
# ---------------------------------------------------------------------------


class TestNetworkOTDistributedMPC:
    """Test the distributed MPC with network-based OT triple generation.

    Uses 2 validators (coordinator + 1 peer) so the 2-party OT protocol
    runs over HTTP. Triples are generated via the 4-phase Gilboa OT protocol
    without a trusted dealer.
    """

    @staticmethod
    def _env_context(key: str, value: str):
        """Context manager to set/restore an env var."""
        import os
        import contextlib

        @contextlib.contextmanager
        def _ctx():
            old = os.environ.get(key)
            os.environ[key] = value
            try:
                yield
            finally:
                if old is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = old

        return _ctx()

    @staticmethod
    def _routers(clients):
        """Create routed post/get functions for test clients."""
        real_post = httpx.AsyncClient.post
        real_get = httpx.AsyncClient.get

        async def routed_post(self_client, url, **kwargs):
            for i, client in enumerate(clients):
                base = f"http://v{i}:8421"
                if url.startswith(base):
                    path = url[len(base):]
                    return await client.post(path, **kwargs)
            return await real_post(self_client, url, **kwargs)

        async def routed_get(self_client, url, **kwargs):
            for i, client in enumerate(clients):
                base = f"http://v{i}:8421"
                if url.startswith(base):
                    path = url[len(base):]
                    return await client.get(path, **kwargs)
            return await real_get(self_client, url, **kwargs)

        return routed_post, routed_get

    async def _run_network_ot_mpc(
        self,
        secret: int,
        available: set[int],
        signal_id: str = "sig-ot",
    ) -> MPCResult | None:
        """Helper: run distributed MPC with network OT for a 2-validator setup.

        Uses the BN254 field prime (required for MPC protocol correctness)
        with a small DH group (p=1223) for fast OT key exchange in tests.
        """
        from httpx import ASGITransport

        from djinn_validator.core.ot_network import DH_GROUP_TEST

        n_validators = 2
        threshold = 2
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store(signal_id, "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                    ot_dh_group=DH_GROUP_TEST,
                )
                peers = [{"uid": 1, "url": "http://v1:8421"}]

                routed_post, routed_get = self._routers(clients)

                with self._env_context("USE_NETWORK_OT", "true"):
                    with patch.object(httpx.AsyncClient, "post", routed_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get):
                        return await orchestrator._distributed_mpc(
                            signal_id=signal_id,
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )
            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_network_ot_available(self) -> None:
        """2 validators using network OT, secret IS in available set."""
        result = await self._run_network_ot_mpc(
            secret=5, available={3, 5, 7}, signal_id="sig-ot-avail",
        )
        assert result is not None
        assert result.available is True
        assert result.participating_validators == 2

    @pytest.mark.asyncio
    async def test_network_ot_unavailable(self) -> None:
        """2 validators using network OT, secret NOT in available set."""
        result = await self._run_network_ot_mpc(
            secret=5, available={1, 2, 3}, signal_id="sig-ot-unavail",
        )
        assert result is not None
        assert result.available is False

    @pytest.mark.asyncio
    async def test_network_ot_single_index_match(self) -> None:
        """Single available index that matches the secret."""
        result = await self._run_network_ot_mpc(
            secret=7, available={7}, signal_id="sig-ot-single",
        )
        assert result is not None
        assert result.available is True

    @pytest.mark.asyncio
    async def test_network_ot_single_index_no_match(self) -> None:
        """Single available index that does NOT match."""
        result = await self._run_network_ot_mpc(
            secret=7, available={3}, signal_id="sig-ot-nomatch",
        )
        assert result is not None
        assert result.available is False

    @pytest.mark.asyncio
    async def test_network_ot_all_ten_indices(self) -> None:
        """Test every index 1-10 against a fixed available set with OT triples."""
        available = {2, 5, 8}
        for secret in range(1, 11):
            result = await self._run_network_ot_mpc(
                secret=secret, available=available, signal_id=f"sig-ot-idx-{secret}",
            )
            assert result is not None
            expected = secret in available
            assert result.available is expected, (
                f"secret={secret}, expected={expected}, got={result.available}"
            )

    @pytest.mark.asyncio
    async def test_network_ot_fallback_when_ot_fails(self) -> None:
        """Falls back to local triple generation when OT peer fails."""
        from httpx import ASGITransport

        n_validators = 2
        threshold = 2
        secret = 5
        available = {3, 5, 7}
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-ot-fail", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
            ]

            try:
                coordinator = MPCCoordinator()
                orchestrator = MPCOrchestrator(
                    coordinator=coordinator, neuron=None, threshold=threshold,
                )
                peers = [{"uid": 1, "url": "http://v1:8421"}]

                real_post = httpx.AsyncClient.post
                call_count = 0
                _, routed_get_fn = self._routers(clients)

                async def ot_failing_post(self_client, url, **kwargs):
                    nonlocal call_count
                    # Fail OT setup but allow MPC init/compute_gate/result
                    if "/v1/mpc/ot/" in url:
                        raise httpx.ConnectError("OT peer down")
                    for i, client in enumerate(clients):
                        base = f"http://v{i}:8421"
                        if url.startswith(base):
                            path = url[len(base):]
                            return await client.post(path, **kwargs)
                    return await real_post(self_client, url, **kwargs)

                with self._env_context("USE_NETWORK_OT", "true"):
                    with patch.object(httpx.AsyncClient, "post", ot_failing_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get_fn):
                        result = await orchestrator._distributed_mpc(
                            signal_id="sig-ot-fail",
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )

                # Should still succeed via fallback to local triple generation
                assert result is not None
                assert result.available is True
            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()

    @pytest.mark.asyncio
    async def test_network_ot_not_used_for_three_peers(self) -> None:
        """Network OT is only used for 2-party case (coordinator + 1 peer).
        With 3 validators (2 peers), falls back to local triple generation."""
        from httpx import ASGITransport

        n_validators = 3
        threshold = 2
        secret = 5
        available = {3, 5, 7}
        shares = split_secret(secret, n=n_validators, k=threshold)

        stores: list[ShareStore] = []
        try:
            for share in shares:
                store = ShareStore()
                store.store("sig-ot-3v", "0xG", share, b"k")
                stores.append(store)

            apps = [_create_validator_app(store) for store in stores]
            clients = [
                httpx.AsyncClient(
                    transport=ASGITransport(app=app),
                    base_url=f"http://v{i}:8421",
                )
                for i, app in enumerate(apps)
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
                routed_post, routed_get_fn = self._routers(clients)

                ot_called = False
                real_post = httpx.AsyncClient.post

                async def tracking_post(self_client, url, **kwargs):
                    nonlocal ot_called
                    if "/v1/mpc/ot/" in url:
                        ot_called = True
                    return await routed_post(self_client, url, **kwargs)

                with self._env_context("USE_NETWORK_OT", "true"):
                    with patch.object(httpx.AsyncClient, "post", tracking_post), \
                         patch.object(httpx.AsyncClient, "get", routed_get_fn):
                        result = await orchestrator._distributed_mpc(
                            signal_id="sig-ot-3v",
                            local_share=shares[0],
                            available_indices=available,
                            peers=peers,
                        )

                assert result is not None
                assert result.available is True
                # OT endpoints should NOT be called for 3-validator case
                assert not ot_called, "OT endpoints should not be used with >1 peer"
            finally:
                for c in clients:
                    await c.aclose()
        finally:
            for store in stores:
                store.close()
