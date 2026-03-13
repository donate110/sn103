"""Minimal test for distributed MPC with threshold=2 and 3 participants.

Simulates the exact protocol used in mpc_orchestrator._distributed_mpc
to verify correctness with the production threshold and participant count.
"""

import secrets
from djinn_validator.core.mpc import (
    DistributedParticipantState,
    _split_secret_at_points,
    generate_beaver_triples,
    reconstruct_at_zero,
)
from djinn_validator.utils.crypto import BN254_PRIME, Share


def test_distributed_mpc_threshold2_available():
    """Secret IS in available set. Should return result=0 (available)."""
    p = BN254_PRIME
    secret = 5  # The real pick index
    threshold = 2
    participant_xs = [1, 2, 3]  # 3 validators with share x=1,2,3
    available_indices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]  # secret 5 is in here

    # Split the secret into Shamir shares
    secret_shares = _split_secret_at_points(secret, participant_xs, threshold, p)
    secret_map = {s.x: s.y for s in secret_shares}

    # Generate random mask r
    r = secrets.randbelow(p - 1) + 1
    r_shares = _split_secret_at_points(r, participant_xs, threshold, p)
    r_map = {s.x: s.y for s in r_shares}

    # Generate Beaver triples (one per available index)
    n_gates = len(available_indices)
    triples = generate_beaver_triples(
        count=n_gates, n=len(participant_xs), k=threshold,
        x_coords=participant_xs,
    )

    # Extract per-participant triple shares
    def get_triples_for(x):
        out = []
        for triple in triples:
            a = next(s.y for s in triple.a_shares if s.x == x)
            b = next(s.y for s in triple.b_shares if s.x == x)
            c = next(s.y for s in triple.c_shares if s.x == x)
            out.append({"a": a, "b": b, "c": c})
        return out

    # Create participant states (simulating coordinator + 2 peers)
    states = {}
    for x in participant_xs:
        ts = get_triples_for(x)
        states[x] = DistributedParticipantState(
            validator_x=x,
            secret_share_y=secret_map[x],
            r_share_y=r_map[x],
            available_indices=sorted(available_indices),
            triple_a=[t["a"] for t in ts],
            triple_b=[t["b"] for t in ts],
            triple_c=[t["c"] for t in ts],
        )

    # Run per-gate protocol
    prev_d = None
    prev_e = None
    for gate_idx in range(n_gates):
        d_vals = {}
        e_vals = {}
        for x in participant_xs:
            d_i, e_i = states[x].compute_gate(gate_idx, prev_d, prev_e)
            d_vals[x] = d_i
            e_vals[x] = e_i

        prev_d = reconstruct_at_zero(d_vals, p)
        prev_e = reconstruct_at_zero(e_vals, p)

    # Compute output shares
    z_vals = {}
    for x in participant_xs:
        z_vals[x] = states[x].compute_output_share(prev_d, prev_e)

    result = reconstruct_at_zero(z_vals, p)
    assert result == 0, f"Expected 0 (available), got {result}"
    print("PASS: threshold=2, secret in available set -> result=0")


def test_distributed_mpc_threshold2_unavailable():
    """Secret NOT in available set. Should return result!=0 (unavailable)."""
    p = BN254_PRIME
    secret = 5
    threshold = 2
    participant_xs = [1, 2, 3]
    available_indices = [1, 2, 3, 4, 6, 7, 8, 9, 10]  # secret 5 is NOT here

    secret_shares = _split_secret_at_points(secret, participant_xs, threshold, p)
    secret_map = {s.x: s.y for s in secret_shares}

    r = secrets.randbelow(p - 1) + 1
    r_shares = _split_secret_at_points(r, participant_xs, threshold, p)
    r_map = {s.x: s.y for s in r_shares}

    n_gates = len(available_indices)
    triples = generate_beaver_triples(
        count=n_gates, n=len(participant_xs), k=threshold,
        x_coords=participant_xs,
    )

    def get_triples_for(x):
        out = []
        for triple in triples:
            a = next(s.y for s in triple.a_shares if s.x == x)
            b = next(s.y for s in triple.b_shares if s.x == x)
            c = next(s.y for s in triple.c_shares if s.x == x)
            out.append({"a": a, "b": b, "c": c})
        return out

    states = {}
    for x in participant_xs:
        ts = get_triples_for(x)
        states[x] = DistributedParticipantState(
            validator_x=x,
            secret_share_y=secret_map[x],
            r_share_y=r_map[x],
            available_indices=sorted(available_indices),
            triple_a=[t["a"] for t in ts],
            triple_b=[t["b"] for t in ts],
            triple_c=[t["c"] for t in ts],
        )

    prev_d = None
    prev_e = None
    for gate_idx in range(n_gates):
        d_vals = {}
        e_vals = {}
        for x in participant_xs:
            d_i, e_i = states[x].compute_gate(gate_idx, prev_d, prev_e)
            d_vals[x] = d_i
            e_vals[x] = e_i
        prev_d = reconstruct_at_zero(d_vals, p)
        prev_e = reconstruct_at_zero(e_vals, p)

    z_vals = {}
    for x in participant_xs:
        z_vals[x] = states[x].compute_output_share(prev_d, prev_e)

    result = reconstruct_at_zero(z_vals, p)
    assert result != 0, f"Expected nonzero (unavailable), got 0"
    print("PASS: threshold=2, secret NOT in available set -> result!=0")


def test_distributed_mpc_threshold2_subset_participants():
    """Use only 2 of 3 participants (threshold=2). Should still work."""
    p = BN254_PRIME
    secret = 3
    threshold = 2
    all_xs = [1, 2, 3]
    # Only use 2 participants for the MPC
    participant_xs = [1, 3]
    available_indices = [1, 2, 3, 4, 5]

    # Shares are created for all 3, but MPC uses only 2
    secret_shares = _split_secret_at_points(secret, all_xs, threshold, p)
    secret_map = {s.x: s.y for s in secret_shares}

    r = secrets.randbelow(p - 1) + 1
    r_shares = _split_secret_at_points(r, participant_xs, threshold, p)
    r_map = {s.x: s.y for s in r_shares}

    n_gates = len(available_indices)
    triples = generate_beaver_triples(
        count=n_gates, n=len(participant_xs), k=threshold,
        x_coords=participant_xs,
    )

    def get_triples_for(x):
        out = []
        for triple in triples:
            a = next(s.y for s in triple.a_shares if s.x == x)
            b = next(s.y for s in triple.b_shares if s.x == x)
            c = next(s.y for s in triple.c_shares if s.x == x)
            out.append({"a": a, "b": b, "c": c})
        return out

    states = {}
    for x in participant_xs:
        ts = get_triples_for(x)
        states[x] = DistributedParticipantState(
            validator_x=x,
            secret_share_y=secret_map[x],
            r_share_y=r_map[x],
            available_indices=sorted(available_indices),
            triple_a=[t["a"] for t in ts],
            triple_b=[t["b"] for t in ts],
            triple_c=[t["c"] for t in ts],
        )

    prev_d = None
    prev_e = None
    for gate_idx in range(n_gates):
        d_vals = {}
        e_vals = {}
        for x in participant_xs:
            d_i, e_i = states[x].compute_gate(gate_idx, prev_d, prev_e)
            d_vals[x] = d_i
            e_vals[x] = e_i
        prev_d = reconstruct_at_zero(d_vals, p)
        prev_e = reconstruct_at_zero(e_vals, p)

    z_vals = {}
    for x in participant_xs:
        z_vals[x] = states[x].compute_output_share(prev_d, prev_e)

    result = reconstruct_at_zero(z_vals, p)
    assert result == 0, f"Expected 0 (available), got {result}"
    print("PASS: threshold=2, 2/3 participants, secret in set -> result=0")


def test_hex_roundtrip():
    """Test that hex encoding/decoding matches the real protocol."""
    p = BN254_PRIME
    secret = 7
    threshold = 2
    participant_xs = [1, 2, 3]
    available_indices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

    secret_shares = _split_secret_at_points(secret, participant_xs, threshold, p)
    secret_map = {s.x: s.y for s in secret_shares}

    r = secrets.randbelow(p - 1) + 1
    r_shares = _split_secret_at_points(r, participant_xs, threshold, p)
    r_map = {s.x: s.y for s in r_shares}

    n_gates = len(available_indices)
    triples = generate_beaver_triples(
        count=n_gates, n=len(participant_xs), k=threshold,
        x_coords=participant_xs,
    )

    def get_triples_for(x):
        out = []
        for triple in triples:
            a = next(s.y for s in triple.a_shares if s.x == x)
            b = next(s.y for s in triple.b_shares if s.x == x)
            c = next(s.y for s in triple.c_shares if s.x == x)
            out.append({"a": a, "b": b, "c": c})
        return out

    # Coordinator (x=1) creates states directly
    ts1 = get_triples_for(1)
    coordinator_state = DistributedParticipantState(
        validator_x=1,
        secret_share_y=secret_map[1],
        r_share_y=r_map[1],
        available_indices=sorted(available_indices),
        triple_a=[t["a"] for t in ts1],
        triple_b=[t["b"] for t in ts1],
        triple_c=[t["c"] for t in ts1],
    )

    # Peers (x=2, x=3) receive hex-encoded values (simulating HTTP transport)
    peer_states = {}
    for x in [2, 3]:
        ts = get_triples_for(x)
        # Simulate hex encoding + decoding (as in init_peer -> mpc_init)
        hex_triples = [{k: hex(v) for k, v in t.items()} for t in ts]
        hex_r = hex(r_map[x])

        # Parse back (as in server.py mpc_init handler)
        parsed_a = [int(t["a"], 16) for t in hex_triples]
        parsed_b = [int(t["b"], 16) for t in hex_triples]
        parsed_c = [int(t["c"], 16) for t in hex_triples]
        parsed_r = int(hex_r, 16)

        peer_states[x] = DistributedParticipantState(
            validator_x=x,
            secret_share_y=secret_map[x],
            r_share_y=parsed_r,
            available_indices=sorted(available_indices),
            triple_a=parsed_a,
            triple_b=parsed_b,
            triple_c=parsed_c,
        )

    all_states = {1: coordinator_state, **peer_states}

    # Run gates
    prev_d = None
    prev_e = None
    for gate_idx in range(n_gates):
        d_vals = {}
        e_vals = {}
        for x in participant_xs:
            d_i, e_i = all_states[x].compute_gate(gate_idx, prev_d, prev_e)
            d_vals[x] = d_i
            e_vals[x] = e_i

        prev_d = reconstruct_at_zero(d_vals, p)
        prev_e = reconstruct_at_zero(e_vals, p)

        # Simulate hex roundtrip of opened d, e (as sent to peers)
        prev_d_hex = hex(prev_d)
        prev_e_hex = hex(prev_e)
        prev_d = int(prev_d_hex, 16)
        prev_e = int(prev_e_hex, 16)

    # Finalize
    z_vals = {}
    for x in participant_xs:
        z_i = all_states[x].compute_output_share(prev_d, prev_e)
        # Simulate hex roundtrip of z_share
        z_hex = hex(z_i)
        z_vals[x] = int(z_hex, 16)

    result = reconstruct_at_zero(z_vals, p)
    assert result == 0, f"Expected 0 (available) after hex roundtrip, got {result}"
    print("PASS: hex roundtrip, secret in set -> result=0")


if __name__ == "__main__":
    test_distributed_mpc_threshold2_available()
    test_distributed_mpc_threshold2_unavailable()
    test_distributed_mpc_threshold2_subset_participants()
    test_hex_roundtrip()
    print("\nAll distributed MPC threshold=2 tests passed!")
