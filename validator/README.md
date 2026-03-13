# Djinn Validator

Bittensor Subnet 103 validator for the Djinn Protocol. Validators challenge miners to verify sports betting line availability, dispatch TLSNotary attestation tasks, manage peer notary assignment, and set on-chain weights based on miner performance.

## Quick Start

```bash
# Install dependencies
uv sync

# Set required environment variables (see below)
export BT_NETWORK=finney
export BT_WALLET_NAME=default
export BT_WALLET_HOTKEY=default
export BASE_VALIDATOR_PRIVATE_KEY=0x...

# Run the validator
uv run python -m djinn_validator
```

The validator starts a FastAPI server on port 8421 (configurable via `API_PORT`) and enters the epoch loop concurrently.

## Epoch Loop

Every ~12 seconds the validator runs one epoch iteration:

1. **Metagraph sync** (30s timeout). Discovers registered miners and prunes deregistered UIDs from the scorer.
2. **Health checks**. Pings every miner's `/health` endpoint (5s timeout). Parses capability data (memory, CPU, TLSNotary session headroom) from JSON responses. Miners that don't respond are marked as down.
3. **Sports challenge** (every 50 epochs, ~10 minutes). Picks a live sport from ESPN, constructs a mix of real and synthetic betting lines, sends the same challenge to all miners concurrently, computes cross-miner consensus, and requests TLSNotary proofs from outliers.
4. **Attestation challenge** (every 100 epochs, ~20 minutes). Probes all miners for `/v1/attest` capability, discovers peer notaries, then dispatches full TLSNotary attestation tasks to capable miners with assigned peer notaries.
5. **Outcome resolution**. Resolves pending signal outcomes using public ESPN game data.
6. **MPC audit settlement**. When a full audit set (10 signals) is ready, runs batch MPC to compute aggregate quality scores and submits on-chain votes.
7. **Weight setting** (every 100 blocks). Computes blended scores, applies burn fraction, and sets weights on the Bittensor chain.

After weights are set, per-epoch metrics reset while preserving consecutive participation history.

## Miner Scoring

Final weights are a blend of sports and attestation scores:

```
final_score = 0.70 * sports_score + 0.30 * attestation_score
```

### Sports Score (70% of final)

| Component   | Weight | Description |
|-------------|--------|-------------|
| Accuracy    | 35%    | Fraction of queries matching cross-miner consensus and TLSNotary ground truth |
| Speed       | 25%    | Response latency, normalized across all miners |
| Coverage    | 15%    | Fraction of proof requests where a valid TLSNotary proof was submitted |
| Uptime      | 15%    | Fraction of health checks responded to (with notary bonus, see below) |
| Capability  | 10%    | System resource score from health check capabilities |

### Attestation Score (30% of final)

| Component       | Weight | Description |
|-----------------|--------|-------------|
| Proof Validity  | 60%    | TLSNotary proof verifies correctly |
| Speed           | 40%    | Attestation latency, normalized independently |

### Notary Freerider Penalty

Miners not running a notary sidecar receive a **50% reduction** on their attestation score. This incentivizes every operator to contribute notary capacity proportional to their miner count.

### Notary Bonus

Miners that reliably serve as peer notaries for other miners receive up to a **10% boost** on their uptime component within the sports score. This rewards network service without changing the weight structure.

### Capability Scoring

The 10% capability component is computed from miner-reported system resources:

- **Memory tier** (0-0.4): 8GB = 0.1, 16GB = 0.2, 32GB = 0.3, 64GB+ = 0.4
- **CPU tier** (0-0.2): 4 cores = 0.05, 8 = 0.1, 16 = 0.15, 32+ = 0.2
- **Memory availability** (0-0.2): ratio of available to total memory
- **Session headroom** (0-0.2): ratio of free to max TLSNotary concurrent sessions

Miners that do not report capabilities receive a neutral score of 0.3 (not penalized, not rewarded).

### Empty Epoch Weights

When no miners have been challenged (no active signals):

- Without attestation data: Uptime 50%, History 50% (consecutive participation, log-scaled)
- With attestation data: Uptime 35%, History 30%, Attestation 35%

## Capability-Aware Scheduling

Validators parse miner capabilities from health check responses and use them for:

- **Scoring**: 10% of sports weight goes to the capability component.
- **Attestation dispatch**: miners with available TLSNotary capacity are preferred for challenge selection.
- **Notary ranking**: fully loaded notaries receive up to 30% score penalty in `rank_notary_candidates`, which combines notary duty reliability (50%), attestation validity (35%), and uptime (15%) with a capacity factor.
- **Smart routing**: the concurrency semaphore (4 simultaneous attestation challenges) and per-notary assignment caps prevent overwhelming any single miner.

## Attestation Dispatch

Attestation challenges select miners in two phases:

### Phase 1: Discovery (~5 seconds)

Runs in parallel:
- **Capability probe**: POST empty body to all miners' `/v1/attest`. Miners that return 422 (validation error) have the endpoint; 404 or timeout means they don't.
- **Notary discovery**: GET `/v1/notary/info` from all miners, then WebSocket handshake probe on `/v1/notary/ws` to verify the sidecar actually accepts connections.

### Phase 2: Full Challenge (~210 seconds)

All capable miners receive a real attestation task. Each miner is assigned a peer notary for the TLSNotary MPC session:

- **Peer notary assignment**: weighted-random selection from `rank_notary_candidates` output. Same-IP exclusion prevents collusion between miners on the same machine. Each notary is capped at `max_per_notary` assignments per round (minimum 4, scales with pool size).
- **Proof verification**: the validator verifies TLSNotary proofs against the expected server name and the assigned notary's public key.
- **Notary duty tracking**: when a proof verifies, the notary miner gets credit toward its notary reliability score.

## MPC Audit Flow

Validators compute quality scores for genius-idiot pairs through multi-party computation without revealing which betting line is the real one:

1. **Share collection**. Each signal's secret index (which of the 10 lines is real) is Shamir-secret-shared across validators at purchase time.
2. **Outcome resolution**. ESPN game results determine each line's outcome (FAVORABLE, UNFAVORABLE, or VOID) using public data. No MPC is needed at this stage.
3. **Batch MPC settlement**. When a full audit set (10 signals, 10 lines each = 100 outcomes) is ready, `batch_settle_audit_set` reconstructs the secret index via polynomial interpolation over Shamir shares to select the real outcome for each signal. No individual signal outcome is ever revealed to any single validator.
4. **Quality score computation**. Matches the on-chain `Audit.sol computeScore()` formula:
   - FAVORABLE: `+notional * (odds - 1e6) / 1e6`
   - UNFAVORABLE: `-notional * sla_bps / 10_000`
   - VOID: `0`
5. **On-chain vote**. The aggregate quality score and total notional are submitted to the OutcomeVoting contract. Only the aggregate is published; individual signal results remain private.

In prototype/dev mode, index reconstruction happens locally. In production with distributed MPC, each validator holds one Shamir share and polynomial evaluation prevents any single validator from learning any index.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `BT_NETWORK` | Bittensor network: `finney`, `test`, `local`, or `mock` |
| `BT_WALLET_NAME` | Bittensor wallet name |
| `BT_WALLET_HOTKEY` | Bittensor hotkey name |
| `BASE_VALIDATOR_PRIVATE_KEY` | Hex private key for on-chain settlement transactions (required in production) |

### Chain Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BT_NETUID` | `103` | Bittensor subnet UID |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base chain RPC URL (comma-separated for failover) |
| `BASE_CHAIN_ID` | `8453` | Chain ID (8453 = mainnet, 84532 = sepolia, 31337 = localhost) |
| `BT_BURN_FRACTION` | `0.95` | Fraction of weight assigned to UID 0 for burn |

### Contract Addresses

| Variable | Description |
|----------|-------------|
| `ESCROW_ADDRESS` | Escrow contract address |
| `SIGNAL_COMMITMENT_ADDRESS` | SignalCommitment contract address |
| `ACCOUNT_ADDRESS` | Account contract address |
| `COLLATERAL_ADDRESS` | Collateral contract address |
| `OUTCOME_VOTING_ADDRESS` | OutcomeVoting contract address |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `API_HOST` | `0.0.0.0` | Bind address for the validator API |
| `API_PORT` | `8421` | Bind port for the validator API |
| `EXTERNAL_IP` | (empty) | Public IP for metagraph discovery (set when behind NAT) |
| `EXTERNAL_PORT` | `0` | Public port for metagraph discovery |

### Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_TIMEOUT` | `30` | HTTP request timeout in seconds |
| `RPC_TIMEOUT` | `30` | RPC call timeout in seconds |
| `MPC_PEER_TIMEOUT` | `10.0` | Timeout for MPC peer communication |
| `MPC_AVAILABILITY_TIMEOUT` | `90.0` | Timeout waiting for MPC quorum availability |
| `SHAMIR_THRESHOLD` | `7` | Minimum shares needed for secret reconstruction (must be >= 3 in production) |
| `RATE_LIMIT_CAPACITY` | `60` | Token bucket capacity for API rate limiting |
| `RATE_LIMIT_RATE` | `10` | Token refill rate per second |
| `FALLBACK_MINER_URL` | (empty) | Fallback miner URL when no miners are on the metagraph |
| `ADMIN_API_KEY` | (empty) | Bearer token for admin/telemetry endpoints (optional) |
| `DATA_DIR` | `data` | Directory for SQLite databases (shares, attestations, purchases) |

## Testing

```bash
uv run pytest tests/
```
