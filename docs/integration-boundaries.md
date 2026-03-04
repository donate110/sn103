# Integration Boundary Matrix

Every cross-service call in the Djinn system, what auth it requires, and what breaks per environment.

## Components

| Component | Runtime | Notes |
|-----------|---------|-------|
| **Web Client** | Next.js on Vercel (browser + API routes) | API routes proxy to validators/miners |
| **Validator** | Python FastAPI on dedicated server | Registered on Bittensor SN103 |
| **Miner** | Python FastAPI on dedicated server | Registered on Bittensor SN103 |
| **Subtensor** | Bittensor chain (HTTP JSON-RPC) | Public endpoints |
| **Base Chain** | Ethereum L2 (RPC via ethers.js / web3.py) | Mainnet or Sepolia |
| **The Odds API** | External REST API | Requires API key |
| **ESPN** | External REST API (public) | No key needed |
| **The Graph** | Subgraph (GraphQL) | Optional |

---

## 1. Browser → Next.js API Routes

All browser calls go through `/api/…` proxies. The browser never hits external services directly.

| Call | Proxy Path | Auth | On Failure |
|------|-----------|------|-----------|
| Line check (genius/idiot) | `/api/validator/v1/check` | CSRF Origin | "No miner available" error |
| Store share (genius) | `/api/validators/{uid}/v1/signal` | CSRF Origin | Signal creation fails |
| Purchase signal (idiot) | `/api/validator/v1/signal/{id}/purchase` | Buyer EIP-191 sig + CSRF | Purchase fails |
| Odds data | `/api/odds?sport=…` | Rate-limited 30/min/IP | No odds shown |
| Attestation | `/api/attest` | Rate-limited 5/min/IP | Error shown |
| Validator discovery | `/api/validators/discover` | None (30s cache) | Falls back to single validator |
| Miner discovery | `/api/miners/discover` | None (30s cache) | Returns empty array |
| Delegate names | `/api/delegates` | None (10min cache) | Empty map |
| Beta gate | `/api/beta/verify` | Password or cookie | 401 |
| Admin auth | `/api/admin/auth` | Password → HMAC cookie | 401 |
| Error reports | `/api/report-error` | Rate-limited 5/10min | Silent fail |

## 2. Next.js API Routes → External Services

| Source | Target | Auth | Timeout | On Failure | Env Difference |
|--------|--------|------|---------|-----------|----------------|
| Validator proxy | Validator axon | None | 30s | 502 | URL from metagraph discovery or env var |
| Miner proxy | Miner axon | None | 30s | 502 | URL from metagraph discovery or env var |
| Odds proxy | `api.the-odds-api.com` | `ODDS_API_KEY` in query | 10s | 503 | Key required all envs |
| Metagraph discovery | Subtensor RPC | None (public) | 8s per URL | Stale cache or empty | `BT_NETWORK` controls endpoints |
| Delegate names | GitHub raw | None | 10s | Empty map, cached | Same all envs |
| Error reports | GitHub API | `GITHUB_ERROR_TOKEN` Bearer | 10s | Silent fail | Skipped if no token |

### Critical: Metagraph → Miner health probes (testnet only)

On testnet where all nodes have `validatorPermit=true`, the miner discovery path probes each node's `/health` endpoint to identify miners by `odds_api_connected` field. This adds N×3s latency.

## 3. Validator → Miner

| Endpoint | Auth | Timeout | On Failure |
|----------|------|---------|-----------|
| `POST /v1/check` (challenge) | Bittensor hotkey HMAC signature | 10s | Scored as incorrect |
| `POST /v1/check` (buyer proxy) | Bittensor hotkey HMAC signature | 10s | Try next miner (up to 5) |
| `POST /v1/proof` (TLSNotary) | Same | 30s | No proof credit |
| `POST /v1/attest` (web attestation) | Same | 60–210s | Try next miner |

**KEY INSIGHT:** Miner auth on finney defaults to enabled. The caller's IP must be a registered subnet neuron OR the request must carry signed validator headers. **Vercel's IP is neither.** This is why the web client must route through a validator, not directly to miners.

## 4. Validator → Validator (MPC)

| Endpoint | Auth | Timeout | On Failure |
|----------|------|---------|-----------|
| `POST /v1/mpc/init` | HMAC | ~30s | Peer excluded |
| `POST /v1/mpc/compute_gate` | HMAC | ~30s | Session may fail threshold |
| `POST /v1/mpc/finalize` | HMAC | ~30s | Peer excluded |
| `POST /v1/mpc/result` | HMAC | ~30s | Peer doesn't learn result |
| `POST /v1/mpc/abort` | HMAC | ~30s | Fire-and-forget |
| `POST /v1/mpc/ot/*` (5 endpoints) | HMAC | ~30s | OT path fails |
| `GET /v1/identity` | None | 5s | Peer silently skipped |

## 5. Validator → Bittensor Subtensor

| Call | Auth | On Failure |
|------|------|-----------|
| `Subtensor(network=…)` connect | None (public) | Degraded mode |
| `metagraph(netuid)` sync | None | Stale miner list |
| `serve_axon(netuid, axon)` | Hotkey wallet sig | Not discoverable |
| `set_weights(netuid, uids, weights)` | Hotkey wallet sig | Weights not updated |

## 6. Validator → Base Chain

| Call | Auth | On Failure |
|------|------|-----------|
| `getSignal(id)` (read) | None | Returns empty |
| `isActive(id)` (read) | None | Returns false (fail-safe) |
| `verify_purchase(id)` (read) | None | Blocks share release in prod |
| `recordOutcome(...)` (write) | `VALIDATOR_PRIVATE_KEY` | Outcome not recorded |
| `setOutcome(...)` (write) | Same | Escrow not updated |
| `submitVote(...)` (write) | Same | Vote not counted |

## 7. Miner → External

| Call | Auth | Timeout | On Failure |
|------|------|---------|-----------|
| The Odds API odds fetch | `ODDS_API_KEY` query param | 10s + 3 retries | Circuit breaker (60s recovery) |
| ESPN scoreboard | None | 15s | Challenge skipped this epoch |

## 8. Browser → Base Chain (direct via wallet)

| Call | Auth | On Failure |
|------|------|-----------|
| All contract reads (balances, signals, etc.) | None (public RPC) | UI shows "—" |
| All contract writes (deposit, purchase, commit) | Wallet signature (MetaMask popup) | User rejects → error |
| USDC approve | Wallet signature | Error shown |

---

## What Breaks Per Environment

| Boundary | Dev (local) | Testnet | **Mainnet** |
|----------|-------------|---------|-------------|
| Miner auth | Disabled | Configurable | **Enabled by default** — Vercel can't call directly |
| Buyer auth (purchase) | Disabled | Configurable | Should be enabled |
| Subtensor RPC | localhost:9933 | test.finney | entrypoint-finney + lite.chain (fallback) |
| Base RPC | Sepolia | Sepolia | mainnet.base.org |
| USDC | Test token | Test token | Real USDC (0x833589…) |
| Odds API | Needs real key | Same | Same |
| MPC | Single validator | May work distributed | Distributed (threshold validators) |
| Chain writes | Skipped if no key | Needs funded Sepolia addr | Needs funded Base mainnet addr |
| Subgraph | Optional | Optional | Optional |

---

## Key Fragility Points

1. **Odds API key is single point of failure** for miners. Quota exhaustion or revocation breaks all `/v1/check` responses. Circuit breaker prevents hammering but miner is useless until key restored.

2. **Subtensor RPC outage blocks metagraph discovery.** 60s cache masks brief outages. Sustained outage → web client returns empty validator/miner lists.

3. **Base chain RPC outage blocks share release in production.** `verify_purchase()` returns `{pricePaid:0}` on error → purchase endpoint returns 502 rather than releasing shares without payment confirmation. This is deliberate.

4. **MPC wallet unavailability** means empty auth headers → peer validators reject requests.

5. **Vercel function timeout (10s default, 60s max on Pro)** constrains metagraph RPC calls. Current timeout: 8s per URL with 2 fallback URLs.

---

## Testing Checklist (pre-mainnet)

For each row in the matrix, verify:
- [ ] Happy path works in target environment
- [ ] Auth mechanism works (not just "auth disabled in dev")
- [ ] Timeout/failure path returns sensible error (not hang or crash)
- [ ] Retry/fallback works when first attempt fails
- [ ] No SSRF: private IPs rejected where applicable
- [ ] Rate limits tested under load

### Smoke test commands

```bash
# Metagraph discovery (from Vercel)
curl https://djinn.gg/api/debug/metagraph

# Validator health (direct)
curl http://{validator_ip}:{port}/health

# Miner health (direct)
curl http://{miner_ip}:{port}/health

# Line check through validator (the fixed path)
curl -X POST http://{validator_ip}:{port}/v1/check \
  -H "Content-Type: application/json" \
  -d '{"lines":[{"index":1,"event_id":"test","market":"h2h","selection":"Team A","line":-110}]}'

# Line check through web proxy (end-to-end)
curl -X POST https://djinn.gg/api/validator/v1/check \
  -H "Content-Type: application/json" \
  -H "Origin: https://djinn.gg" \
  -d '{"lines":[{"index":1,"event_id":"test","market":"h2h","selection":"Team A","line":-110}]}'
```
