"""End-to-end purchase flow test with 3 actual validator HTTP servers.

Simulates the full purchase flow as it happens in production:
1. Start 3 FastAPI validator server instances on different ports
2. Create a signal with Shamir-shared index and precomputed Beaver triples
3. Store shares on each validator via POST /v1/signal
4. Run the purchase flow via POST /v1/signal/{id}/purchase
5. Verify MPC succeeds across the 3 servers and shares are released
6. Reconstruct the AES key from the collected shares

This test uses real HTTP communication between validators for the MPC protocol
(init, compute_gate, finalize). No mocking of the MPC transport layer.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import socket
import time
from contextlib import closing
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import uvicorn

# Disable network OT for tests (it attempts real network DH key exchange
# which times out on localhost). Local OT triple generation still works.
os.environ["USE_NETWORK_OT"] = "false"

from djinn_validator.api.server import create_app
from djinn_validator.core.mpc import (
    BeaverTriple,
    _split_secret_at_points,
    generate_beaver_triples,
    reconstruct_at_zero,
)
from djinn_validator.core.mpc_coordinator import MPCCoordinator
from djinn_validator.core.mpc_orchestrator import MPCOrchestrator
from djinn_validator.core.outcomes import OutcomeAttestor
from djinn_validator.core.purchase import PurchaseOrchestrator
from djinn_validator.core.shares import PrecomputedTriple, ShareStore
from djinn_validator.utils.crypto import BN254_PRIME, Share, split_secret


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_free_port() -> int:
    """Find and return a free TCP port on localhost."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return s.getsockname()[1]


class _ValidatorNode:
    """Holds all per-validator state for the test."""

    def __init__(self, port: int, share_x: int) -> None:
        self.port = port
        self.share_x = share_x
        self.url = f"http://127.0.0.1:{port}"
        self.share_store = ShareStore()  # in-memory SQLite
        self.mpc_coordinator = MPCCoordinator()
        self.purchase_orch = PurchaseOrchestrator(self.share_store)
        self.outcome_attestor = OutcomeAttestor()
        self.app = create_app(
            share_store=self.share_store,
            purchase_orch=self.purchase_orch,
            outcome_attestor=self.outcome_attestor,
            chain_client=None,       # dev mode: skip payment verification
            neuron=None,             # dev mode: skip auth and metagraph
            mpc_coordinator=self.mpc_coordinator,
            shares_threshold=2,      # low threshold for 3-validator test
        )
        self.server: uvicorn.Server | None = None

    def cleanup(self) -> None:
        self.share_store.close()
        self.purchase_orch.close()


def _start_server(node: _ValidatorNode) -> None:
    """Start a uvicorn server in the current thread (blocking)."""
    config = uvicorn.Config(
        app=node.app,
        host="127.0.0.1",
        port=node.port,
        log_level="warning",
    )
    server = uvicorn.Server(config)
    node.server = server
    server.run()


async def _wait_for_server(url: str, timeout: float = 10.0) -> None:
    """Wait until a server is responding to health checks."""
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.get(f"{url}/health", timeout=2.0)
                if resp.status_code == 200:
                    return
            except (httpx.ConnectError, httpx.ReadError, httpx.ConnectTimeout):
                pass
            await asyncio.sleep(0.1)
    raise TimeoutError(f"Server at {url} did not start within {timeout}s")


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_purchase_flow_with_three_validators() -> None:
    """End-to-end: 3 validator servers, signal creation, MPC purchase, key reconstruction."""

    # Configuration
    n_validators = 3
    threshold = 2
    signal_id = "test-signal-001"
    genius_address = "0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d"
    buyer_address = "0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37"
    real_index = 3  # The real signal index (1-10)
    available_indices = [1, 2, 3, 4, 5]  # Indices reported as available (real_index is in here)

    # Allocate ports and create validator nodes
    ports = [_find_free_port() for _ in range(n_validators)]
    x_coords = list(range(1, n_validators + 1))  # share x-coordinates: 1, 2, 3
    nodes = [_ValidatorNode(port=ports[i], share_x=x_coords[i]) for i in range(n_validators)]

    # --- Step 1: Generate Shamir shares for the AES key and the real index ---

    # AES key (a random secret we want to recover after purchase)
    aes_key_secret = secrets.randbelow(BN254_PRIME)
    aes_key_shares = split_secret(aes_key_secret, n=n_validators, k=threshold)

    # Real index shares (used by MPC to check availability)
    index_shares = split_secret(real_index, n=n_validators, k=threshold)

    # --- Step 2: Generate precomputed Beaver triples ---
    # These are raw (a, b, c) values. The orchestrator will Shamir-split them
    # at the actual participant x-coordinates during the purchase flow.
    n_triples = max(len(available_indices), 1)
    raw_triples: list[dict[str, int]] = []
    for _ in range(n_triples):
        a = secrets.randbelow(BN254_PRIME)
        b = secrets.randbelow(BN254_PRIME)
        c = (a * b) % BN254_PRIME
        raw_triples.append({"a": a, "b": b, "c": c})

    # --- Step 3: Start validator servers in background threads ---
    import threading

    threads = []
    try:
        for node in nodes:
            t = threading.Thread(target=_start_server, args=(node,), daemon=True)
            t.start()
            threads.append(t)

        # Wait for all servers to be ready
        for node in nodes:
            await _wait_for_server(node.url, timeout=15.0)

        # --- Step 4: Store shares on each validator via HTTP ---
        async with httpx.AsyncClient(timeout=10.0) as client:
            for i, node in enumerate(nodes):
                payload = {
                    "signal_id": signal_id,
                    "genius_address": genius_address,
                    "share_x": x_coords[i],
                    "share_y": hex(aes_key_shares[i].y),
                    "encrypted_key_share": aes_key_shares[i].y.to_bytes(32, "big").hex(),
                    "encrypted_index_share": index_shares[i].y.to_bytes(32, "big").hex(),
                    "shamir_threshold": threshold,
                    "precomputed_triples": [
                        {"a": hex(t["a"]), "b": hex(t["b"]), "c": hex(t["c"])}
                        for t in raw_triples
                    ],
                }
                resp = await client.post(f"{node.url}/v1/signal", json=payload)
                assert resp.status_code == 200, f"Failed to store share on validator {i+1}: {resp.text}"
                data = resp.json()
                assert data["stored"] is True

            # Verify shares are stored
            for i, node in enumerate(nodes):
                assert node.share_store.has(signal_id), f"Validator {i+1} should hold a share"
                record = node.share_store.get(signal_id)
                assert record is not None
                assert record.share.x == x_coords[i]
                assert record.shamir_threshold == threshold
                assert len(record.precomputed_triples) == n_triples

        # --- Step 5: Patch the coordinator's orchestrator to know about peers ---
        # The coordinator is validator 0 (nodes[0]).
        # In production, peers come from the Bittensor metagraph.
        # In this test, we inject them directly.
        coordinator = nodes[0]
        peer_list = [
            {
                "uid": i + 1,   # Arbitrary UIDs for the test
                "hotkey": f"hotkey-{i+1}",
                "ip": "127.0.0.1",
                "port": nodes[i + 1].port,
                "url": nodes[i + 1].url,
            }
            for i in range(n_validators - 1)  # peers = validators 1 and 2
        ]

        # Patch the _get_peer_validators method on the orchestrator instance
        # inside the coordinator's FastAPI app. We need to find the orchestrator
        # object that was created inside create_app.
        #
        # The orchestrator is captured in the closure of the app's route handlers.
        # We can access it via the mpc_diagnostic endpoint's reference, or we
        # can monkey-patch at the module level. The simplest approach: patch the
        # MPCOrchestrator class method to return our peer list.

        # Find the _orchestrator object from the app's closure
        # It's stored as a nonlocal in the create_app closure. We can get it
        # by inspecting the mpc_diagnostic endpoint which references _orchestrator.
        _orchestrator_ref = None
        for route in coordinator.app.routes:
            if hasattr(route, "endpoint") and hasattr(route.endpoint, "__code__"):
                if "mpc_diagnostic" in getattr(route.endpoint, "__name__", ""):
                    # Get the closure cell that holds _orchestrator
                    for cell in (route.endpoint.__code__.co_freevars):
                        pass
                    # Try getting from __closure__
                    closure = route.endpoint.__closure__
                    if closure:
                        for cell_obj in closure:
                            val = cell_obj.cell_contents
                            if isinstance(val, MPCOrchestrator):
                                _orchestrator_ref = val
                                break

        # Alternative: scan all routes for any function that uses _orchestrator
        if _orchestrator_ref is None:
            for route in coordinator.app.routes:
                if not hasattr(route, "endpoint"):
                    continue
                closure = getattr(route.endpoint, "__closure__", None)
                if not closure:
                    continue
                for cell_obj in closure:
                    try:
                        val = cell_obj.cell_contents
                        if isinstance(val, MPCOrchestrator):
                            _orchestrator_ref = val
                            break
                    except ValueError:
                        continue
                if _orchestrator_ref is not None:
                    break

        assert _orchestrator_ref is not None, "Could not find MPCOrchestrator in coordinator app"

        # Monkey-patch the orchestrator to return our peer list
        original_get_peers = _orchestrator_ref._get_peer_validators
        _orchestrator_ref._get_peer_validators = lambda: peer_list

        # Also need to relax SSRF check: the orchestrator's _peer_request
        # uses httpx directly so it works with localhost. The _is_public_ip
        # check is in _get_peer_validators, which we've already replaced.

        # --- Step 6: Run the purchase flow ---
        async with httpx.AsyncClient(timeout=60.0) as client:
            purchase_payload = {
                "buyer_address": buyer_address,
                "sportsbook": "DraftKings",
                "available_indices": available_indices,
                "buyer_signature": "",  # dev mode: no signature required
            }
            resp = await client.post(
                f"{coordinator.url}/v1/signal/{signal_id}/purchase",
                json=purchase_payload,
            )

            # --- Step 7: Verify the response ---
            assert resp.status_code == 200, f"Purchase failed: {resp.status_code} {resp.text}"
            data = resp.json()

            print(f"\nPurchase response: {data}")
            print(f"  status: {data['status']}")
            print(f"  available: {data.get('available')}")
            print(f"  encrypted_key_share: {data.get('encrypted_key_share', 'N/A')[:40]}...")
            print(f"  share_x: {data.get('share_x')}")
            print(f"  mpc_participants: {data.get('mpc_participants')}")

            assert data["status"] == "complete", f"Expected 'complete', got '{data['status']}': {data.get('message', '')} (failure_reason: {data.get('mpc_failure_reason', 'N/A')})"
            assert data["available"] is True
            assert data["encrypted_key_share"] is not None
            assert data["share_x"] is not None

        # --- Step 8: Collect shares from all validators and reconstruct ---
        # In production, the buyer would call purchase on each validator.
        # For this test, we already got the coordinator's share. Let's also
        # get shares from the other validators by purchasing on them too.
        #
        # But first, let's verify the coordinator's share is correct.
        coordinator_share_hex = data["encrypted_key_share"]
        coordinator_share_x = data["share_x"]
        coordinator_share_y = int.from_bytes(bytes.fromhex(coordinator_share_hex), "big")

        # Verify it matches the original AES key share
        expected_share = aes_key_shares[coordinator_share_x - 1]
        assert coordinator_share_y == expected_share.y, (
            f"Released share doesn't match original: got {coordinator_share_y}, expected {expected_share.y}"
        )

        # Now purchase from the other validators too (they need their own MPC).
        # For simplicity, patch each one's orchestrator to find the others as peers.
        all_released_shares: list[Share] = [
            Share(x=coordinator_share_x, y=coordinator_share_y),
        ]

        for i in range(1, n_validators):
            node = nodes[i]
            # Find this node's orchestrator
            node_orch = None
            for route in node.app.routes:
                if not hasattr(route, "endpoint"):
                    continue
                closure = getattr(route.endpoint, "__closure__", None)
                if not closure:
                    continue
                for cell_obj in closure:
                    try:
                        val = cell_obj.cell_contents
                        if isinstance(val, MPCOrchestrator):
                            node_orch = val
                            break
                    except ValueError:
                        continue
                if node_orch is not None:
                    break

            if node_orch is not None:
                # Set up peers for this node (all other nodes)
                this_peers = [
                    {
                        "uid": j * 10 + i,  # unique UIDs
                        "hotkey": f"hotkey-{j}-{i}",
                        "ip": "127.0.0.1",
                        "port": nodes[j].port,
                        "url": nodes[j].url,
                    }
                    for j in range(n_validators) if j != i
                ]
                node_orch._get_peer_validators = lambda p=this_peers: p

            # Purchase on this validator
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{node.url}/v1/signal/{signal_id}/purchase",
                    json={
                        "buyer_address": buyer_address,
                        "sportsbook": "DraftKings",
                        "available_indices": available_indices,
                        "buyer_signature": "",
                    },
                )
                assert resp.status_code == 200, f"Purchase on validator {i+1} failed: {resp.text}"
                data = resp.json()
                assert data["status"] == "complete", (
                    f"Validator {i+1} purchase not complete: {data['status']} "
                    f"(reason: {data.get('mpc_failure_reason', 'N/A')})"
                )
                released_y = int.from_bytes(bytes.fromhex(data["encrypted_key_share"]), "big")
                all_released_shares.append(Share(x=data["share_x"], y=released_y))

        # --- Step 9: Reconstruct the AES key from collected shares ---
        # We need at least `threshold` shares to reconstruct
        assert len(all_released_shares) >= threshold, (
            f"Not enough shares for reconstruction: {len(all_released_shares)} < {threshold}"
        )

        from djinn_validator.utils.crypto import reconstruct_secret

        reconstructed_key = reconstruct_secret(all_released_shares[:threshold])
        assert reconstructed_key == aes_key_secret, (
            f"Reconstructed key doesn't match original: {reconstructed_key} != {aes_key_secret}"
        )

        print(f"\n  Reconstructed AES key matches original secret!")
        print(f"  Used {threshold} of {n_validators} shares for reconstruction")
        print(f"  All {n_validators} validators participated in MPC successfully")

    finally:
        # Cleanup
        _orchestrator_ref._get_peer_validators = original_get_peers if _orchestrator_ref and 'original_get_peers' in dir() else lambda: []
        for node in nodes:
            if node.server is not None:
                node.server.should_exit = True
            node.cleanup()
        # Give threads a moment to exit
        for t in threads:
            t.join(timeout=3.0)


@pytest.mark.asyncio
async def test_purchase_unavailable_index() -> None:
    """Purchase with real_index NOT in available_indices should return unavailable."""

    n_validators = 3
    threshold = 2
    signal_id = "test-signal-unavail"
    genius_address = "0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d"
    buyer_address = "0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37"
    real_index = 7  # NOT in available_indices below
    available_indices = [1, 2, 3, 4, 5]  # real_index=7 is NOT here

    ports = [_find_free_port() for _ in range(n_validators)]
    x_coords = list(range(1, n_validators + 1))
    nodes = [_ValidatorNode(port=ports[i], share_x=x_coords[i]) for i in range(n_validators)]

    aes_key_secret = secrets.randbelow(BN254_PRIME)
    aes_key_shares = split_secret(aes_key_secret, n=n_validators, k=threshold)
    index_shares = split_secret(real_index, n=n_validators, k=threshold)

    n_triples = max(len(available_indices), 1)
    raw_triples = []
    for _ in range(n_triples):
        a = secrets.randbelow(BN254_PRIME)
        b = secrets.randbelow(BN254_PRIME)
        c = (a * b) % BN254_PRIME
        raw_triples.append({"a": a, "b": b, "c": c})

    import threading
    threads = []

    try:
        for node in nodes:
            t = threading.Thread(target=_start_server, args=(node,), daemon=True)
            t.start()
            threads.append(t)

        for node in nodes:
            await _wait_for_server(node.url, timeout=15.0)

        async with httpx.AsyncClient(timeout=10.0) as client:
            for i, node in enumerate(nodes):
                payload = {
                    "signal_id": signal_id,
                    "genius_address": genius_address,
                    "share_x": x_coords[i],
                    "share_y": hex(aes_key_shares[i].y),
                    "encrypted_key_share": aes_key_shares[i].y.to_bytes(32, "big").hex(),
                    "encrypted_index_share": index_shares[i].y.to_bytes(32, "big").hex(),
                    "shamir_threshold": threshold,
                    "precomputed_triples": [
                        {"a": hex(t["a"]), "b": hex(t["b"]), "c": hex(t["c"])}
                        for t in raw_triples
                    ],
                }
                resp = await client.post(f"{node.url}/v1/signal", json=payload)
                assert resp.status_code == 200

        # Find and patch coordinator orchestrator
        coordinator = nodes[0]
        _orchestrator_ref = None
        for route in coordinator.app.routes:
            if not hasattr(route, "endpoint"):
                continue
            closure = getattr(route.endpoint, "__closure__", None)
            if not closure:
                continue
            for cell_obj in closure:
                try:
                    val = cell_obj.cell_contents
                    if isinstance(val, MPCOrchestrator):
                        _orchestrator_ref = val
                        break
                except ValueError:
                    continue
            if _orchestrator_ref is not None:
                break

        assert _orchestrator_ref is not None
        peer_list = [
            {
                "uid": i + 1,
                "hotkey": f"hotkey-{i+1}",
                "ip": "127.0.0.1",
                "port": nodes[i + 1].port,
                "url": nodes[i + 1].url,
            }
            for i in range(n_validators - 1)
        ]
        _orchestrator_ref._get_peer_validators = lambda: peer_list

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{coordinator.url}/v1/signal/{signal_id}/purchase",
                json={
                    "buyer_address": buyer_address,
                    "sportsbook": "DraftKings",
                    "available_indices": available_indices,
                    "buyer_signature": "",
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            print(f"\nUnavailable purchase response: {data}")
            assert data["status"] == "unavailable", f"Expected 'unavailable', got '{data['status']}'"
            assert data["available"] is False
            # No share should be released
            assert data.get("encrypted_key_share") is None

        print("  Correctly rejected purchase for unavailable index")

    finally:
        for node in nodes:
            if node.server is not None:
                node.server.should_exit = True
            node.cleanup()
        for t in threads:
            t.join(timeout=3.0)
