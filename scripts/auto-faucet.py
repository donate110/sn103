#!/usr/bin/env python3
"""Auto-faucet: Claims Base Sepolia testnet ETH via Coinbase CDP SDK.

Requires CDP_API_KEY_ID and CDP_API_KEY_SECRET env vars (or ~/.cdp/api_key.json).
Get credentials at: https://portal.cdp.coinbase.com/access/api

Usage:
    python scripts/auto-faucet.py [address] [--token eth]

If no address is given, defaults to the deployer wallet.
"""

import asyncio
import os
import sys
import json

DEPLOYER = "0xD717b5fbA93F123f6ad530ae2Ab327B4DcDa1e37"
GENIUS_G0 = "0x68fc8eeC9E5551d4c93a89b6d861f0a05e0A2A1d"
NETWORK = "base-sepolia"


async def claim_faucet(address: str, token: str = "eth") -> str | None:
    """Claim testnet tokens from CDP faucet. Returns tx hash or None on failure."""
    try:
        from cdp import CdpClient
    except ImportError:
        print("ERROR: cdp-sdk not installed. Run: uv pip install cdp-sdk")
        return None

    # Check for credentials
    key_id = os.environ.get("CDP_API_KEY_ID", "")
    key_secret = os.environ.get("CDP_API_KEY_SECRET", "")
    key_file = os.path.expanduser("~/.cdp/api_key.json")

    if not key_id and os.path.exists(key_file):
        with open(key_file) as f:
            data = json.load(f)
            key_id = data.get("api_key_id", data.get("name", ""))
            key_secret = data.get("api_key_secret", data.get("privateKey", ""))

    if not key_id or not key_secret:
        print("ERROR: No CDP credentials found.")
        print("Set CDP_API_KEY_ID and CDP_API_KEY_SECRET env vars,")
        print("or create ~/.cdp/api_key.json with your API key.")
        print("Get credentials at: https://portal.cdp.coinbase.com/access/api")
        return None

    async with CdpClient(
        api_key_id=key_id,
        api_key_secret=key_secret,
    ) as client:
        print(f"Requesting {token} on {NETWORK} for {address}...")
        tx_hash = await client.evm.request_faucet(
            address=address,
            network=NETWORK,
            token=token,
        )
        print(f"Faucet tx: {tx_hash}")
        return tx_hash


async def main():
    address = sys.argv[1] if len(sys.argv) > 1 else DEPLOYER
    token = "eth"

    # Parse --token flag
    for i, arg in enumerate(sys.argv):
        if arg == "--token" and i + 1 < len(sys.argv):
            token = sys.argv[i + 1]

    result = await claim_faucet(address, token)
    if result:
        print(f"Success! TX: {result}")
        # Also claim for genius if we claimed for deployer
        if address == DEPLOYER:
            print(f"\nAlso claiming for genius G0...")
            result2 = await claim_faucet(GENIUS_G0, token)
            if result2:
                print(f"Genius funded! TX: {result2}")
    else:
        print("Faucet claim failed.")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
