#!/usr/bin/env python3
"""Auto-faucet: Claims Base Sepolia testnet ETH via Coinbase CDP SDK.

The CDP faucet gives 0.0001 ETH per call, up to 1000 calls per 24h rolling
window. This script loops to accumulate the target amount.

Requires CDP_API_KEY_ID and CDP_API_KEY_SECRET env vars (or ~/.cdp/api_key.json).
Get credentials at: https://portal.cdp.coinbase.com/access/api

Usage:
    python scripts/auto-faucet.py [address] [--target 0.01] [--token eth]

If no address is given, claims for both deployer and genius G0.
"""

import asyncio
import os
import sys
import json
import time

DEPLOYER = "0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37"
GENIUS_G0 = "0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d"
NETWORK = "base-sepolia"
ETH_PER_CLAIM = 0.0001
MAX_CLAIMS_PER_RUN = 200  # Safety cap per invocation (0.02 ETH)


def get_credentials() -> tuple[str, str] | None:
    key_id = os.environ.get("CDP_API_KEY_ID", "")
    key_secret = os.environ.get("CDP_API_KEY_SECRET", "")
    key_file = os.path.expanduser("~/.cdp/api_key.json")

    if not key_id and os.path.exists(key_file):
        with open(key_file) as f:
            data = json.load(f)
            key_id = data.get("api_key_id", data.get("name", ""))
            key_secret = data.get("api_key_secret", data.get("privateKey", ""))

    if not key_id or not key_secret:
        return None
    return key_id, key_secret


async def fill_wallet(address: str, target_eth: float = 0.01, token: str = "eth") -> int:
    """Claim faucet repeatedly until target_eth is accumulated. Returns claim count."""
    creds = get_credentials()
    if not creds:
        print("ERROR: No CDP credentials found.")
        print("Set CDP_API_KEY_ID and CDP_API_KEY_SECRET env vars,")
        print("or create ~/.cdp/api_key.json with your API key.")
        print("Get credentials at: https://portal.cdp.coinbase.com/access/api")
        return 0

    try:
        from cdp import CdpClient
    except ImportError:
        print("ERROR: cdp-sdk not installed. Run: uv pip install cdp-sdk")
        return 0

    claims_needed = min(int(target_eth / ETH_PER_CLAIM), MAX_CLAIMS_PER_RUN)
    print(f"Filling {address[:10]}... with ~{target_eth} ETH ({claims_needed} claims at {ETH_PER_CLAIM} each)")

    claimed = 0
    errors = 0
    key_id, key_secret = creds

    async with CdpClient(api_key_id=key_id, api_key_secret=key_secret) as client:
        for i in range(claims_needed):
            try:
                tx_hash = await client.evm.request_faucet(
                    address=address,
                    network=NETWORK,
                    token=token,
                )
                claimed += 1
                if claimed % 10 == 0 or claimed == 1:
                    print(f"  [{claimed}/{claims_needed}] +{ETH_PER_CLAIM} ETH (tx: {tx_hash[:16]}...)")
            except Exception as e:
                errors += 1
                err_str = str(e)
                if "rate" in err_str.lower() or "limit" in err_str.lower():
                    print(f"  Rate limited after {claimed} claims, stopping.")
                    break
                if errors > 5:
                    print(f"  Too many errors ({errors}), stopping. Last: {err_str[:100]}")
                    break
                # Brief pause on error
                await asyncio.sleep(1)

    total_eth = claimed * ETH_PER_CLAIM
    print(f"Done: {claimed} claims, ~{total_eth:.4f} ETH added to {address[:10]}...")
    return claimed


async def main():
    address = None
    target = 0.01
    token = "eth"

    # Parse args
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--target" and i + 1 < len(args):
            target = float(args[i + 1])
            i += 2
        elif args[i] == "--token" and i + 1 < len(args):
            token = args[i + 1]
            i += 2
        elif not args[i].startswith("--"):
            address = args[i]
            i += 1
        else:
            i += 1

    if address:
        await fill_wallet(address, target, token)
    else:
        # Fill both deployer and genius
        print("=== Filling deployer ===")
        await fill_wallet(DEPLOYER, target, token)
        print()
        print("=== Filling genius G0 ===")
        await fill_wallet(GENIUS_G0, target, token)


if __name__ == "__main__":
    start = time.time()
    asyncio.run(main())
    elapsed = time.time() - start
    print(f"\nCompleted in {elapsed:.1f}s")
