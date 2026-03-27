# Running a Djinn Miner

Miners verify real-time betting line availability and generate TLSNotary proofs for the Djinn Protocol on Bittensor Subnet 103.

## Requirements

- **CPU:** 2+ cores, 2.0 GHz+
- **RAM:** 4 GB minimum
- **Storage:** 5 GB SSD
- **Network:** Stable connection, 100 Mbps+ download
- **GPU:** Not required
- **OS:** Ubuntu 22.04+ recommended

See `min_compute.yml` in the repository root for full hardware specs.

## Prerequisites

- Python 3.11+
- A registered Bittensor wallet with stake on Subnet 103
- Sports data source: [The Odds API](https://the-odds-api.com) key (default) or a custom provider via `SPORTS_DATA_PROVIDER`

## Installation

```bash
cd miner
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
| `ODDS_API_KEY` | Conditional | API key from The Odds API (required if using default provider) |
| `ODDS_API_BASE_URL` | No | Odds API base URL (default: `https://api.the-odds-api.com`) |
| `SPORTS_DATA_PROVIDER` | No | Custom data provider module path (default: built-in Odds API client) |
| `ODDS_CACHE_TTL` | No | Cache TTL in seconds (default: `30`) |
| `LINE_TOLERANCE` | No | Line matching tolerance (default: `0.5`) |
| `API_HOST` | No | Bind address (default: `0.0.0.0`) |
| `API_PORT` | No | API port (default: `8422`) |
| `LOG_FORMAT` | No | `console` or `json` (default: `console`) |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARNING`, `ERROR` (default: `INFO`) |

### TLSNotary Configuration (Optional)

| Variable | Description |
|----------|-------------|
| `TLSN_NOTARY_HOST` | TLSNotary server host (default: `notary.pse.dev`) |
| `TLSN_NOTARY_PORT` | TLSNotary server port (default: `443`) |
| `TLSN_PROVER_BINARY` | Path to TLSNotary prover binary |

## Running

```bash
# Direct
djinn-miner

# Or with Docker
docker compose up miner
```

The miner exposes:
- **API:** `http://localhost:8422` — Line check and proof endpoints
- **Health:** `http://localhost:8422/health` — Health check endpoint
- **Metrics:** `http://localhost:8422/metrics` — Prometheus metrics

## What the Miner Does

1. **Line Availability Checking:** When validators request a line check, the miner queries live odds APIs to verify whether a specific betting line is currently available at the claimed price.

2. **TLSNotary Proof Generation:** For verified line checks, the miner generates TLSNotary proofs — cryptographic attestations that the odds data was genuinely fetched from the sportsbook API, preventing fabrication.

3. **Response to Validators:** Miners respond to validator queries with line check results and optional TLS proofs. Validators score miners on response latency, accuracy, and proof quality.

## Scoring

Miners are scored by validators on:
- **Response latency** — Faster responses score higher
- **Accuracy** — Correct line availability checks
- **Proof quality** — Valid TLSNotary proofs when requested
- **Uptime** — Consistent availability

Higher scores earn more TAO emissions from the Bittensor network.

## Monitoring

The miner exposes Prometheus metrics at `/metrics`:
- `miner_checks_total` — Total line checks performed
- `miner_check_duration_seconds` — Time per line check
- `miner_proofs_generated_total` — Total TLSNotary proofs generated
- `miner_api_requests_total` — Total API requests received

## Troubleshooting

- **"Config validation failed"**: Check all required env vars are set.
- **Odds API 401**: Verify your `ODDS_API_KEY` is valid and has remaining quota.
- **TLSNotary errors**: Ensure the notary server is reachable and the prover binary is in your PATH.
- **Low scores**: Check response latency — consider running on hardware closer to odds API servers.
