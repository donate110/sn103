#!/usr/bin/env python3
"""Sweep accumulated attestation burn fees to SN103 UID 0.

Run via cron every hour:
  0 * * * * /usr/bin/python3 /home/user/djinn/scripts/sweep-burns.py >> /tmp/sweep-burns.log 2>&1

Transfers the full balance (minus existential deposit + fees) from the
djinn-burn wallet to SN103 UID 0's coldkey.
"""

import sys

import bittensor as bt

BURN_WALLET_NAME = "djinn-burn"
NETWORK = "finney"
SN103_UID0_COLDKEY = "5CcRAHrH5CjNhAMDU6iE2UaaDUx7EyZskUeXfkgn1pTULbh7"
# Minimum balance worth sweeping (below this, skip to save on fees)
MIN_SWEEP_TAO = 0.001


def main() -> None:
    w = bt.Wallet(name=BURN_WALLET_NAME)
    sub = bt.Subtensor(network=NETWORK)

    balance = sub.get_balance(w.coldkeypub.ss58_address)
    balance_tao = float(balance.tao) if hasattr(balance, "tao") else float(balance)

    print(f"Burn wallet balance: {balance}")

    if balance_tao < MIN_SWEEP_TAO:
        print(f"Below minimum sweep threshold ({MIN_SWEEP_TAO} TAO), skipping.")
        return

    # transfer_all=True sends everything minus existential deposit + fees
    result = sub.transfer(
        wallet=w,
        destination_ss58=SN103_UID0_COLDKEY,
        amount=None,
        transfer_all=True,
        wait_for_inclusion=True,
        wait_for_finalization=False,
    )

    if result.success:
        new_balance = sub.get_balance(w.coldkeypub.ss58_address)
        print(f"Swept to UID 0 coldkey {SN103_UID0_COLDKEY}")
        print(f"Remaining balance: {new_balance}")
    else:
        print(f"Sweep failed: {result.error or result.message}")
        sys.exit(1)


if __name__ == "__main__":
    main()
