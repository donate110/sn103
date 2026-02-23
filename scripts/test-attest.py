#!/usr/bin/env python3
"""Test the attestation flow end-to-end.

1. Burns a small amount of TAO to the burn address
2. Waits for the burn to be confirmed
3. Finds a validator from the metagraph
4. Submits an attestation request with the burn tx hash
5. Prints the result

Usage:
    python scripts/test-attest.py
    python scripts/test-attest.py --wallet-name mywallet --url https://example.com --network test
"""

from __future__ import annotations

import argparse
import sys
import time
import uuid

import bittensor as bt
import httpx

BURN_ADDRESS = "5E9tjcvFc9F9xPzGeCDoSkHoWKWmUvq4T4saydcSGL5ZbxKV"
BURN_AMOUNT_TAO = 0.0001
NETUID = 103


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test attestation flow end-to-end")
    parser.add_argument(
        "--wallet-name",
        default="minetensor",
        help="Bittensor wallet name (default: minetensor)",
    )
    parser.add_argument(
        "--hotkey",
        default="default",
        help="Bittensor hotkey name (default: default)",
    )
    parser.add_argument(
        "--url",
        default="https://example.com",
        help="URL to attest (default: https://example.com)",
    )
    parser.add_argument(
        "--network",
        default="test",
        choices=["test", "finney", "local"],
        help="Bittensor network (default: test)",
    )
    parser.add_argument(
        "--burn-amount",
        type=float,
        default=BURN_AMOUNT_TAO,
        help=f"Amount of TAO to burn (default: {BURN_AMOUNT_TAO})",
    )
    parser.add_argument(
        "--validator-url",
        default=None,
        help="Explicit validator URL (skip metagraph discovery)",
    )
    return parser.parse_args()


def burn_tao(
    wallet: bt.Wallet,
    subtensor: bt.Subtensor,
    amount: float,
) -> str:
    """Transfer TAO to the burn address and return the extrinsic hash."""
    coldkey_addr = wallet.coldkeypub.ss58_address
    balance = subtensor.get_balance(coldkey_addr)
    balance_tao = float(balance.tao) if hasattr(balance, "tao") else float(balance)

    print(f"Wallet: {coldkey_addr}")
    print(f"Balance: {balance_tao:.6f} TAO")

    if balance_tao < amount + 0.0001:
        print(f"Insufficient balance. Need at least {amount + 0.0001:.6f} TAO.")
        sys.exit(1)

    print(f"Burning {amount} TAO to {BURN_ADDRESS}...")

    result = subtensor.transfer(
        wallet=wallet,
        destination_ss58=BURN_ADDRESS,
        amount=amount,
        wait_for_inclusion=True,
        wait_for_finalization=True,
    )

    if not result.success:
        error = getattr(result, "error", None) or getattr(result, "message", "Unknown error")
        print(f"Burn failed: {error}")
        sys.exit(1)

    # Extract the extrinsic hash from the result
    tx_hash: str | None = None
    if hasattr(result, "extrinsic_hash"):
        tx_hash = result.extrinsic_hash
    elif hasattr(result, "tx_hash"):
        tx_hash = result.tx_hash
    elif hasattr(result, "block_hash"):
        # Fall back to searching for the extrinsic in the block
        tx_hash = find_burn_extrinsic(subtensor, result.block_hash, coldkey_addr)

    if not tx_hash:
        print("Burn succeeded but could not extract extrinsic hash from result.")
        print(f"Result attributes: {dir(result)}")
        print(f"Result: {result}")
        sys.exit(1)

    # Normalize hash format
    if not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash

    print(f"Burn confirmed. TX hash: {tx_hash}")
    return tx_hash


def find_burn_extrinsic(
    subtensor: bt.Subtensor,
    block_hash: str,
    sender: str,
) -> str | None:
    """Search a block for our burn extrinsic and return its hash."""
    try:
        substrate = subtensor.substrate
        extrinsics = substrate.get_extrinsics(block_hash=block_hash)
        for ex in extrinsics:
            call = ex.value.get("call", {})
            if call.get("call_module") != "Balances":
                continue
            ex_addr = ex.value.get("address", "")
            if isinstance(ex_addr, dict):
                ex_addr = ex_addr.get("Id", "")
            if ex_addr == sender:
                ex_hash = ex.extrinsic_hash
                if isinstance(ex_hash, bytes):
                    return ex_hash.hex()
                return str(ex_hash)
    except Exception as e:
        print(f"Warning: Could not search block for extrinsic: {e}")
    return None


def discover_validator_url(subtensor: bt.Subtensor, netuid: int) -> str | None:
    """Find a validator URL from the metagraph."""
    print(f"Discovering validators on subnet {netuid}...")
    metagraph = subtensor.metagraph(netuid)
    n = int(metagraph.n.item()) if hasattr(metagraph.n, "item") else int(metagraph.n)

    validators: list[dict] = []
    for uid in range(n):
        permit = metagraph.validator_permit[uid]
        is_validator = bool(permit.item() if hasattr(permit, "item") else permit)
        if not is_validator:
            continue

        axon = metagraph.axons[uid]
        ip = axon.ip
        port = axon.port

        if not ip or ip == "0.0.0.0" or not port:
            continue
        # Skip private IPs
        if ip.startswith("127.") or ip.startswith("10.") or ip.startswith("192.168."):
            continue

        stake = float(metagraph.S[uid].item()) if hasattr(metagraph.S[uid], "item") else float(metagraph.S[uid])
        validators.append({"uid": uid, "ip": ip, "port": port, "stake": stake})

    if not validators:
        return None

    # Sort by stake descending, pick the highest
    validators.sort(key=lambda v: v["stake"], reverse=True)
    best = validators[0]
    url = f"http://{best['ip']}:{best['port']}"
    print(f"Found {len(validators)} validators. Using UID {best['uid']} ({url})")
    return url


def submit_attestation(
    validator_url: str,
    url: str,
    burn_tx_hash: str,
) -> dict:
    """POST an attestation request to the validator."""
    request_id = f"test-{uuid.uuid4().hex[:12]}"
    payload = {
        "url": url,
        "request_id": request_id,
        "burn_tx_hash": burn_tx_hash,
    }

    endpoint = f"{validator_url}/v1/attest"
    print(f"\nSubmitting attestation request to {endpoint}")
    print(f"  URL: {url}")
    print(f"  Request ID: {request_id}")
    print(f"  Burn TX: {burn_tx_hash}")

    resp = httpx.post(endpoint, json=payload, timeout=180.0)

    if resp.status_code != 200:
        print(f"\nAttestation request failed with status {resp.status_code}")
        try:
            error_data = resp.json()
            print(f"  Error: {error_data}")
        except Exception:
            print(f"  Response: {resp.text[:500]}")
        return {"success": False, "status_code": resp.status_code, "error": resp.text[:500]}

    data = resp.json()
    return data


def main() -> None:
    args = parse_args()

    print("=" * 60)
    print("Djinn Attestation Test")
    print("=" * 60)
    print(f"Network:  {args.network}")
    print(f"Wallet:   {args.wallet_name}")
    print(f"URL:      {args.url}")
    print(f"Burn:     {args.burn_amount} TAO")
    print()

    # Initialize bittensor
    wallet = bt.Wallet(name=args.wallet_name, hotkey=args.hotkey)
    subtensor = bt.Subtensor(network=args.network)

    # Step 1: Burn TAO
    print("--- Step 1: Burn TAO ---")
    tx_hash = burn_tao(wallet, subtensor, args.burn_amount)

    # Brief pause to let the burn propagate
    print("\nWaiting 6 seconds for propagation...")
    time.sleep(6)

    # Step 2: Find a validator
    print("\n--- Step 2: Discover Validator ---")
    if args.validator_url:
        validator_url = args.validator_url
        print(f"Using explicit validator URL: {validator_url}")
    else:
        validator_url = discover_validator_url(subtensor, NETUID)
        if not validator_url:
            print("No validators found in the metagraph.")
            print(f"You can retry with --validator-url <url>")
            sys.exit(1)

    # Step 3: Submit attestation
    print("\n--- Step 3: Submit Attestation ---")
    start = time.perf_counter()
    result = submit_attestation(validator_url, args.url, tx_hash)
    elapsed = time.perf_counter() - start

    # Step 4: Print results
    print("\n--- Results ---")
    print(f"Elapsed: {elapsed:.1f}s")

    if result.get("success"):
        print(f"Status:   SUCCESS")
        print(f"Verified: {result.get('verified', False)}")
        if result.get("server_name"):
            print(f"Server:   {result['server_name']}")
        if result.get("proof_hex"):
            proof_len = len(result["proof_hex"]) // 2
            print(f"Proof:    {proof_len} bytes")
        if result.get("error"):
            print(f"Warning:  {result['error']}")
    else:
        print(f"Status:   FAILED")
        print(f"Error:    {result.get('error', result.get('detail', 'Unknown'))}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
