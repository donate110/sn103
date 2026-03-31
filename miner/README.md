# Djinn Miner

Bittensor Subnet 103 miner for the Djinn Protocol. Miners verify sports betting line availability at sportsbooks, generate TLSNotary attestation proofs, and serve as peer notaries for the network's multi-party computation (MPC) infrastructure. Emissions are determined by accuracy, speed, uptime, attestation quality, and system capability.

## Quick Start

```bash
# Install dependencies
uv sync

# Copy and configure environment
cp .env.example .env
# Edit .env: set ODDS_API_KEY, wallet config, etc.

# Run the miner
uv run python -m djinn_miner
```

The miner starts a FastAPI server on port 8422 (configurable via `API_PORT`) and registers with the Bittensor metagraph. Validators will begin sending health checks, line availability queries, and attestation challenges automatically.

### Firewall

Every miner should run a host firewall. Without one, all 65,535 ports respond to probes, making your server easier to fingerprint and target.

**Quick setup (recommended):**

```bash
# Run the included setup script
bash scripts/miner-firewall.sh
```

**Manual setup:**

```bash
# Default deny all incoming traffic
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (change port if you use a non-standard one)
ufw allow 22/tcp

# Miner API port (validator challenges, health checks)
ufw allow 8422/tcp

# Notary sidecar (peer attestation via direct TCP)
ufw allow 7047/tcp

# Rate-limit SSH to slow brute-force attempts (max 6 connections per 30s)
ufw limit 22/tcp

# Enable
ufw --force enable
ufw status verbose
```

**Why both ports matter:**

- **8422/tcp** (API): validators send health checks, line queries, and attestation challenges here. If blocked, your miner scores zero.
- **7047/tcp** (Notary): peer miners connect here for MPC attestation sessions. If blocked, you cannot serve as a peer notary, which reduces your attestation score by up to 50%.

**What this prevents:**

- Port scanning: only 3 ports respond (SSH, API, Notary). Everything else is silently dropped.
- Connection floods: ufw's connection tracking drops malformed packets at the kernel before they reach Python.
- SSH brute force: `ufw limit` caps connection rate to 6 per 30 seconds per IP.

## How Scoring Works

Validators compute miner weights each epoch using two independent scoring tracks that are blended into a final score.

### Sports Challenge Weights (70% of final score)

| Component  | Weight | Description |
|------------|--------|-------------|
| Accuracy   | 35%    | Fraction of Phase 1 line checks that match TLSNotary ground truth |
| Speed      | 25%    | Response latency, normalized across all miners (fastest = 1.0, slowest = 0.0) |
| Coverage   | 15%    | Fraction of proof requests where the miner submitted a valid TLSNotary proof |
| Uptime     | 15%    | Fraction of health checks responded to |
| Capability | 10%    | System resource bonus based on advertised hardware (see below) |

### Attestation Challenge Weights (30% of final score)

| Component      | Weight | Description |
|----------------|--------|-------------|
| Proof validity | 60%    | TLSNotary proof verifies correctly |
| Speed          | 40%    | Attestation latency, normalized independently from sports speed |

### Blending

```
final_score = 0.70 * sports_score + 0.30 * attestation_score
```

If no attestation data exists for the epoch, the final score equals the sports score alone.

### Notary Freerider Penalty

Miners that do not run a notary sidecar receive a **50% reduction** on their attestation score. Every miner is expected to contribute notary capacity proportional to its resource consumption. The notary sidecar is enabled by default.

### Notary Reliability Bonus

Miners that reliably serve as peer notaries (their sidecar successfully completes MPC sessions for other miners) receive up to a 10% bonus on their uptime component within sports scoring.

## Capability Advertisement

The `/health` endpoint automatically reports system capabilities to validators on every health check. Validators use this data for two purposes:

1. **Scoring** (10% of sports weight): higher-capability miners earn more.
2. **Smart task routing**: validators route more attestation work to miners with available capacity.

### Capability Scoring Tiers

The capability score ranges from 0.0 to 1.0, composed of four sub-scores:

**Memory (0 to 0.4)**

| Total RAM | Score |
|-----------|-------|
| 8 GB      | 0.1   |
| 16 GB     | 0.2   |
| 32 GB     | 0.3   |
| 64 GB+    | 0.4   |

**CPU (0 to 0.2)**

| Cores | Score |
|-------|-------|
| 4     | 0.05  |
| 8     | 0.1   |
| 16    | 0.15  |
| 32+   | 0.2   |

**Memory Availability (0 to 0.2)**

Computed as `(available_mb / total_mb) * 0.2`. Miners with most of their RAM free score higher.

**TLSNotary Session Headroom (0 to 0.2)**

Computed as `((max_concurrent - active_sessions) / max_concurrent) * 0.2`. Miners with available attestation slots score higher.

### Default Score

Miners that do not report capabilities receive a neutral score of 0.3. They are not penalized heavily, but miners that do report capabilities and have strong hardware will consistently outscore them.

### Tuning ATTEST_MAX_CONCURRENT

The `ATTEST_MAX_CONCURRENT` environment variable (default 5) controls how many TLSNotary attestation sessions can run simultaneously. Each session consumes significant RAM. Recommended settings:

| RAM   | ATTEST_MAX_CONCURRENT |
|-------|-----------------------|
| 8 GB  | 2                     |
| 16 GB | 3                     |
| 32 GB | 5                     |
| 64 GB | 8                     |

Setting this too high for your hardware will cause OOM kills and failed attestations, which directly reduces your coverage and attestation validity scores.

## API Endpoints

| Method | Path              | Description |
|--------|-------------------|-------------|
| GET    | `/health`         | Health check and capability advertisement. Returns status, version, uptime, and system capabilities. Validators ping this regularly; responsiveness counts toward the 15% uptime weight. |
| GET    | `/health/ready`   | Deep readiness probe. Checks odds API connectivity and Bittensor sync status. |
| POST   | `/v1/check`       | Line availability check (Phase 1). Receives up to 10 candidate lines, returns which are available at sportsbooks with bookmaker details and odds. |
| POST   | `/v1/proof`       | TLSNotary proof generation (Phase 2). Generates a cryptographic proof for a previous check query, referenced by `query_id`. |
| POST   | `/v1/attest`      | Web attestation proof. Generates a TLSNotary proof for an arbitrary HTTPS URL. Subject to `ATTEST_MAX_CONCURRENT` concurrency limit; returns a busy response with `retry_after` when at capacity. |
| GET    | `/v1/attest/capacity` | Returns current attestation slot usage (`inflight`, `max`, `available`). Used by validators for capacity-aware routing. |
| GET    | `/v1/notary/info` | Notary sidecar discovery. Returns whether the miner runs a notary sidecar, its public key, and port. |
| WS     | `/v1/notary/ws`   | Notary MPC WebSocket proxy. Validators and peer miners connect here to reach the local notary sidecar for multi-party TLSNotary sessions. Concurrency limited by `NOTARY_MAX_CONCURRENT`. |
| GET    | `/metrics`        | Prometheus metrics endpoint. |

## Environment Variables

| Variable                | Default                          | Description |
|-------------------------|----------------------------------|-------------|
| `BT_NETUID`            | `103`                            | Bittensor subnet UID |
| `BT_NETWORK`           | `finney`                         | Bittensor network (`finney`, `test`, `local`) |
| `BT_WALLET_NAME`       | `default`                        | Bittensor wallet name |
| `BT_WALLET_HOTKEY`     | `default`                        | Bittensor wallet hotkey |
| `API_HOST`             | `0.0.0.0`                        | Miner API listen address |
| `API_PORT`             | `8422`                           | Miner API listen port |
| `EXTERNAL_IP`          | (auto-detected)                  | Public IP for metagraph registration (set when behind NAT) |
| `EXTERNAL_PORT`        | `0` (uses API_PORT)              | Public port for metagraph registration |
| `ODDS_API_KEY`         | (required)                       | API key from [the-odds-api.com](https://the-odds-api.com) |
| `ODDS_API_BASE_URL`    | `https://api.the-odds-api.com`   | Odds API base URL |
| `ODDS_CACHE_TTL`       | `30`                             | Seconds to cache odds data (0 = no caching) |
| `LINE_TOLERANCE`       | `0.0`                            | How close a sportsbook line must be to match (0.0 = exact) |
| `HTTP_TIMEOUT`         | `30`                             | HTTP request timeout in seconds |
| `ATTEST_MAX_CONCURRENT`| `5`                              | Max simultaneous TLSNotary attestation sessions |
| `NOTARY_MAX_CONCURRENT`| `4`                              | Max simultaneous notary MPC WebSocket sessions |
| `NOTARY_ENABLED`       | `true`                           | Enable the peer notary sidecar (disabling hurts scoring) |
| `NOTARY_PORT`          | `7047`                           | Local TCP port for the notary sidecar |
| `TLSN_NOTARY_HOST`     | `notary.pse.dev`                 | Default TLSNotary server hostname (fallback) |
| `TLSN_NOTARY_PORT`     | `443`                            | Default TLSNotary server port |
| `CORS_ORIGINS`         | `*` (dev), required in production | Comma-separated allowed CORS origins |
| `RATE_LIMIT_CAPACITY`  | `30`                             | Token bucket capacity for rate limiting |
| `RATE_LIMIT_RATE`      | `5`                              | Token bucket refill rate per second |
| `AUTO_UPDATE`          | `true`                           | Enable automatic git pull and restart on new commits |
| `AUTO_UPDATE_BRANCH`   | `main`                           | Git branch to track for auto-updates |
| `AUTO_UPDATE_INTERVAL` | `300`                            | Seconds between update checks |
| `LOG_FORMAT`           | `console`                        | Log output format |
| `LOG_LEVEL`            | `INFO`                           | Log verbosity level |

## Hardware Recommendations

| Tier        | RAM    | CPU Cores | Disk   | Notes |
|-------------|--------|-----------|--------|-------|
| Minimum     | 8 GB   | 4         | 50 GB  | Can run basic line checks. Limited attestation capacity (set `ATTEST_MAX_CONCURRENT=2`). Capability score around 0.15-0.25. |
| Recommended | 32 GB  | 8+        | 100 GB | Handles concurrent attestations comfortably. Capability score around 0.5-0.7. |
| Optimal     | 64 GB  | 16+       | 200 GB | Maximum capability score. Handles 8+ concurrent attestation sessions. Gets priority routing from validators. |

More resources translate directly to a higher capability score, which means more attestation work routed to your miner and higher emissions. The relationship is not linear; the biggest gains come from crossing tier thresholds (8 to 16 GB, 16 to 32 GB, etc.).

## Architecture

```
                         Validators
                             |
                    health checks, queries,
                    attestation challenges
                             |
                     +-------v--------+
                     |  FastAPI Server |  :8422
                     |  (server.py)    |
                     +---+----+---+---+
                         |    |   |
              +----------+    |   +-----------+
              |               |               |
       +------v-----+  +-----v------+  +-----v------+
       | LineChecker |  | TLSNotary  |  | Notary     |
       | (checker)   |  | Prover     |  | Sidecar    |
       +------+------+  | (tlsn)     |  | (notary)   |
              |          +-----+------+  +-----+------+
              |                |               |
        Odds API          Generates        Serves as
        lookups           proofs for       peer notary
                          attestation      via MPC/WS
```

The miner registers on the Bittensor metagraph and exposes its API server. Validators discover miners through the metagraph, send periodic health checks, and dispatch line availability queries and attestation challenges. The miner's responses are scored and blended into weights that determine TAO emissions.
