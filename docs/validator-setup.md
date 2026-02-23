# Djinn Validator Setup — SN103

## Prerequisites

- Registered on Bittensor Subnet 103 with a validator permit
- Python 3.11+ and `uv` package manager
- Machine with a public IP (or port-forwarded) for peer discovery
- ~0.01 Base Sepolia ETH for gas (free from faucets)

## 1. Generate a Base (EVM) Wallet

You need a separate EVM keypair for signing settlement transactions on Base.

```bash
# Using Foundry (recommended)
cast wallet new

# Or using Python
python3 -c "from eth_account import Account; a = Account.create(); print(f'Address: {a.address}\nPrivate Key: {a.key.hex()}')"
```

**Save both the address and private key.** Send only the address to the Djinn team for initial registration.

## 2. Fund Your Wallet

Get free Base Sepolia ETH from any faucet:
- https://www.alchemy.com/faucets/base-sepolia
- https://faucet.quicknode.com/base/sepolia

You need ~0.01 ETH (enough for thousands of transactions on Base L2).

## 3. Clone and Install

```bash
git clone https://github.com/djinn-inc/djinn.git
cd djinn/validator
uv sync
```

## 4. Configure

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Bittensor
BT_NETUID=103
BT_NETWORK=test          # "test" for testnet, "finney" for mainnet
BT_WALLET_NAME=default   # your wallet name
BT_WALLET_HOTKEY=default # your hotkey name

# Base Sepolia (testnet)
BASE_RPC_URL=https://sepolia.base.org
BASE_CHAIN_ID=84532
BASE_VALIDATOR_PRIVATE_KEY=0x...your_private_key_here...

# Contract addresses (these will be provided by the Djinn team after deployment)
ESCROW_ADDRESS=<provided>
SIGNAL_COMMITMENT_ADDRESS=<provided>
ACCOUNT_ADDRESS=<provided>
COLLATERAL_ADDRESS=<provided>
OUTCOME_VOTING_ADDRESS=<provided>

# API — must be reachable by other validators for peer discovery
API_HOST=0.0.0.0
API_PORT=8421

# If behind NAT, set your public IP
# EXTERNAL_IP=1.2.3.4
# EXTERNAL_PORT=8421
```

## 5. Run

```bash
uv run python -m djinn_validator.main
```

The validator will:
1. Connect to Bittensor and sync the metagraph
2. Serve its API on port 8421
3. Run the epoch loop (challenge miners, resolve outcomes, vote on settlements)
4. Automatically sync the on-chain validator set with the metagraph (every 60s)

## 6. Verify It's Working

```bash
# Health check
curl http://localhost:8421/health

# Identity endpoint (used by peers for discovery)
curl http://localhost:8421/v1/identity
```

The identity response should show your `base_address` — this is how peers discover your EVM address.

## What the Validator Does

- **Challenges miners** with sports data questions to verify they have real API access
- **Resolves signal outcomes** when games finish (using ESPN public API)
- **Computes quality scores** via MPC (Multi-Party Computation) to grade Genius predictions without learning which line was the real pick
- **Votes on-chain** with the aggregate quality score — when 2/3+ validators agree, settlement triggers automatically
- **Sets weights** on Bittensor based on miner performance
- **Syncs validator set** — reads the metagraph, discovers peers, proposes on-chain changes via consensus

## Firewall Requirements

Port 8421 (TCP) must be reachable from other validators for:
- `/v1/identity` — peer discovery
- MPC protocol rounds (distributed computation)

## Troubleshooting

- **"not_registered"** — Your hotkey isn't registered on SN103. Check `btcli subnets list --netuid 103`
- **"chain client cannot write"** — `BASE_VALIDATOR_PRIVATE_KEY` not set or invalid
- **"OutcomeVoting contract not configured"** — `OUTCOME_VOTING_ADDRESS` not set
- No weights being set — Wait for `MIN_WEIGHT_INTERVAL` blocks (~100 blocks, ~20 minutes)
