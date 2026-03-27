# Running a Djinn Validator

Validators are the trust backbone of the Djinn Protocol. They hold Shamir key shares for signal encryption, coordinate MPC for key reconstruction on purchase, attest game outcomes, and set weights for miner scoring on Bittensor Subnet 103.

## Requirements

- **CPU:** 4+ cores, 2.5 GHz+
- **RAM:** 8 GB minimum
- **Storage:** 10 GB SSD
- **Network:** Stable connection, 100 Mbps+ download
- **GPU:** Not required
- **OS:** Ubuntu 22.04+ recommended

See `min_compute.yml` in the repository root for full hardware specs.

## Prerequisites

- Python 3.11+
- A registered Bittensor wallet with stake on Subnet 103
- Base chain RPC endpoint (e.g., `https://mainnet.base.org`)
- No paid API keys required (scores come from ESPN's free public API)

## Installation

```bash
cd validator
cp .env.example .env
# Edit .env with your configuration (see below)
pip install -e .
```

## Configuration

All configuration is via environment variables. Copy `.env.example` and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `BT_NETUID` | Yes | Bittensor subnet UID (103) |
| `BT_NETWORK` | Yes | `finney` for mainnet, `test` for testnet, `local` for dev |
| `BT_WALLET_NAME` | Yes | Bittensor wallet name |
| `BT_WALLET_HOTKEY` | Yes | Bittensor hotkey name |
| `BASE_RPC_URL` | Yes | Base chain RPC URL (comma-separated for failover) |
| `BASE_CHAIN_ID` | Yes | `8453` for Base mainnet, `84532` for Sepolia |
| `ESCROW_ADDRESS` | Yes | Deployed Escrow contract address |
| `SIGNAL_COMMITMENT_ADDRESS` | Yes | Deployed SignalCommitment contract address |
| `ACCOUNT_ADDRESS` | Yes | Deployed Account contract address |
| `COLLATERAL_ADDRESS` | Yes | Deployed Collateral contract address |
| `SPORTS_API_KEY` | No | Deprecated. Scores now come from ESPN (free). Kept for backward compatibility but ignored. |
| `API_HOST` | No | Bind address (default: `0.0.0.0`) |
| `API_PORT` | No | API port (default: `8421`) |
| `LOG_FORMAT` | No | `console` or `json` (default: `console`) |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARNING`, `ERROR` (default: `INFO`) |

## Running

```bash
# Direct
djinn-validator

# Or with Docker
docker compose up validator
```

The validator exposes:
- **API:** `http://localhost:8421` — MPC endpoints for key share exchange
- **Health:** `http://localhost:8421/health` — Health check endpoint
- **Metrics:** `http://localhost:8421/metrics` — Prometheus metrics

## What the Validator Does

1. **Key Share Management:** Holds Shamir secret shares for signal encryption. When a buyer purchases a signal, validators participate in MPC to reconstruct the decryption key without any single party seeing the full key.

2. **Outcome Attestation:** Queries ESPN's free public scoreboard API to determine game results. Resolves ALL 10 lines (real + decoys) per signal blindly; no individual outcome is revealed. When 2/3+ of validators agree on the aggregate quality score, settlement is triggered on-chain.

3. **Miner Scoring:** Evaluates miner performance (response latency, TLSNotary proof quality, uptime) and sets weights on the Bittensor network.

4. **Epoch Loop:** Runs a continuous loop checking for pending audits, expired signals, and scoring updates.

## Monitoring

The validator exposes Prometheus metrics at `/metrics`:
- `validator_epoch_duration_seconds` — Time per epoch cycle
- `validator_mpc_sessions_active` — Active MPC sessions
- `validator_outcomes_attested_total` — Total outcomes attested
- `validator_weights_set_total` — Total weight-setting transactions

## Troubleshooting

- **"Config validation failed"**: Check all required env vars are set. The validator fails fast on missing configuration in production mode.
- **MPC timeouts**: Ensure your network allows peer-to-peer connections between validators.
- **RPC errors**: Try adding fallback RPC URLs (comma-separated in `BASE_RPC_URL`).
