# Djinn Agent API Specification

The Agent API is a unified REST interface that wraps on-chain transactions and
validator coordination behind simple endpoints. Any LLM with tool-calling
(Claude, GPT, open-source models, custom agents) can use these as tools to
interact with the Djinn protocol on behalf of geniuses and idiots.

## Authentication

Every request includes:
- `Authorization: Bearer <session-token>` (issued after wallet signature)
- Session tokens are scoped with spending limits and expiry
- On-chain actions produce unsigned transaction payloads; the client signs and
  submits, OR the session key signs within its authorized cap

## Genius Tools

**IMPORTANT: Client-side encryption required.** The genius's real pick must
never leave the client unencrypted. Signal creation is a two-step process:
`prepare` (get validator keys) then `commit` (send encrypted data).
Use the Djinn SDK or implement the encryption locally.

### `GET /api/network/config`

Validator configuration needed by the SDK for signal creation.
Cached; does not change per signal. No authentication required.

Response:
```json
{
  "validators": [
    { "uid": 2, "pubkey": "0x...", "endpoint": "http://34.58.165.14:8421" },
    { "uid": 41, "pubkey": "0x...", "endpoint": "http://37.60.251.252:8421" }
  ],
  "chain_id": 8453,
  "signal_commitment_address": "0x4712...",
  "shamir_n": 10,
  "shamir_k": 3
}
```

### `POST /api/genius/signal/commit`

Submit encrypted signal blob and Shamir shares after client-side encryption.
The API only sees ciphertext. Distributes encrypted shares to validators.

```json
{
  "encrypted_blob": "0x...",
  "commit_hash": "0x...",
  "shares": [
    { "validator_uid": 2, "key_share": "0x...", "index_share": "0x..." },
    { "validator_uid": 41, "key_share": "0x...", "index_share": "0x..." }
  ],
  "commit_tx_hash": "0x...",
  "event_id": "abc123def456",
  "sport": "basketball_nba",
  "fee_bps": 500,
  "sla_multiplier_bps": 15000,
  "max_notional_usdc": 1000,
  "expires_at": "2026-03-28T00:00:00Z"
}
```

Response:
```json
{
  "signal_id": "0xa3f...",
  "status": "active",
  "validators_received_shares": 4,
  "validators_total": 4,
  "collateral_required": 1500,
  "collateral_available": 8000
}
```

### `GET /api/genius/signals`

List all signals for the authenticated genius.

Query params: `?status=active|expired|cancelled|settled&sport=basketball_nba&limit=20&offset=0`

Response:
```json
{
  "signals": [
    {
      "signal_id": "0xa3f...",
      "sport": "basketball_nba",
      "status": "active",
      "created_at": "2026-03-27T18:00:00Z",
      "expires_at": "2026-03-28T00:00:00Z",
      "purchases": 3,
      "total_notional": 750,
      "fees_earned": 37.50
    }
  ],
  "total": 1,
  "offset": 0
}
```

### `DELETE /api/genius/signal/{signal_id}`

Cancel an active signal. Refunds any unreleased escrow to buyers.

Response:
```json
{
  "signal_id": "0xa3f...",
  "status": "cancelled",
  "cancel_tx_hash": "0x..."
}
```

### `GET /api/genius/earnings`

Summary of fees earned, collateral status, and settlement history.

```json
{
  "total_fees_earned_usdc": 1250.00,
  "claimable_fees_usdc": 375.00,
  "pending_settlement_usdc": 200.00,
  "collateral_deposited_usdc": 8000.00,
  "collateral_locked_usdc": 3500.00,
  "collateral_available_usdc": 4500.00,
  "quality_score_30d": 0.72,
  "signals_settled": 14,
  "signals_active": 3
}
```

### `POST /api/genius/claim`

Claim all available fees (subject to 48-hour post-settlement delay).

```json
{
  "claimed_usdc": 375.00,
  "claim_tx_hash": "0x...",
  "next_claimable_at": "2026-03-29T14:00:00Z"
}
```

### `POST /api/genius/collateral/deposit`

Deposit USDC collateral.

```json
{ "amount_usdc": 5000 }
```

### `POST /api/genius/collateral/withdraw`

Withdraw unlocked collateral.

```json
{ "amount_usdc": 2000 }
```

---

## Idiot Tools

### `GET /api/idiot/browse`

Browse available signals with filtering and sorting.

Query params: `?sport=basketball_nba&genius=0x68fc...&min_quality_score=0.5&max_fee_bps=500&sort=quality_score&limit=20`

Response:
```json
{
  "signals": [
    {
      "signal_id": "0xa3f...",
      "genius": "0x68fc...",
      "sport": "basketball_nba",
      "fee_bps": 500,
      "sla_multiplier_bps": 15000,
      "max_notional_usdc": 1000,
      "notional_remaining_usdc": 250,
      "expires_at": "2026-03-28T00:00:00Z",
      "genius_quality_score_30d": 0.72,
      "genius_signals_settled": 14,
      "genius_win_rate": 0.64
    }
  ],
  "total": 12
}
```

### `GET /api/idiot/genius/{address}/profile`

View a genius's public track record.

```json
{
  "address": "0x68fc...",
  "quality_score_30d": 0.72,
  "quality_score_all_time": 0.65,
  "total_signals": 47,
  "settled_signals": 44,
  "win_rate": 0.64,
  "avg_odds": -112,
  "sports": ["basketball_nba", "americanfootball_nfl"],
  "recent_settlements": [
    {
      "cycle": 5,
      "quality_score": 1250,
      "favorable": 7,
      "unfavorable": 2,
      "void": 1,
      "settled_at": "2026-03-25T10:00:00Z"
    }
  ]
}
```

### `POST /api/idiot/purchase`

Purchase a signal. Triggers MPC availability check, escrow debit, and key
share release.

```json
{
  "signal_id": "0xa3f...",
  "notional_usdc": 200
}
```

Response:
```json
{
  "purchase_id": 42,
  "signal_id": "0xa3f...",
  "notional_usdc": 200,
  "fee_usdc": 10.00,
  "available": true,
  "sportsbooks": ["DraftKings", "FanDuel"],
  "encrypted_key_shares": ["0x...", "0x..."],
  "purchase_tx_hash": "0x...",
  "message": "Pick is live. Decrypt with your wallet key to see the 10 lines."
}
```

### `GET /api/idiot/purchases`

List all purchases with outcomes.

Query params: `?status=pending|settled|void&limit=20`

```json
{
  "purchases": [
    {
      "purchase_id": 42,
      "signal_id": "0xa3f...",
      "genius": "0x68fc...",
      "sport": "basketball_nba",
      "notional_usdc": 200,
      "fee_usdc": 10.00,
      "outcome": "favorable",
      "quality_score": 180,
      "purchased_at": "2026-03-27T19:00:00Z",
      "settled_at": "2026-03-28T06:00:00Z"
    }
  ]
}
```

### `GET /api/idiot/balance`

Escrow balance and transaction history.

```json
{
  "escrow_balance_usdc": 2500.00,
  "locked_in_purchases_usdc": 400.00,
  "available_usdc": 2100.00,
  "total_deposited_usdc": 5000.00,
  "total_withdrawn_usdc": 2500.00,
  "total_spent_on_signals_usdc": 1200.00,
  "total_fees_paid_usdc": 60.00,
  "net_pnl_usdc": 340.00
}
```

### `POST /api/idiot/deposit`

Deposit USDC to escrow.

```json
{ "amount_usdc": 1000 }
```

### `POST /api/idiot/withdraw`

Withdraw available USDC from escrow.

```json
{ "amount_usdc": 500 }
```

---

## Shared Tools

### `GET /api/odds`

Current odds from The Odds API (no auth required).

Query params: `?sport=basketball_nba`

### `GET /api/sports`

List supported sports.

### `GET /api/network/status`

Network health: active validators, miner count, attestation success rate.

### `GET /api/settlement/{genius}/{idiot}/status`

Check settlement status for a genius-idiot pair.

```json
{
  "genius": "0x68fc...",
  "idiot": "0x1234...",
  "current_cycle": 3,
  "signals_in_cycle": 7,
  "signals_resolved": 5,
  "signals_pending": 2,
  "ready_for_settlement": false,
  "last_settlement": {
    "cycle": 2,
    "quality_score": 850,
    "settled_at": "2026-03-25T10:00:00Z"
  }
}
```

---

## Session Management

### `POST /api/auth/connect`

Initiate session. Returns a challenge to sign with the user's wallet.

```json
{ "address": "0x68fc..." }
```

### `POST /api/auth/verify`

Submit signed challenge. Returns session token with configurable scope.

```json
{
  "address": "0x68fc...",
  "signature": "0x...",
  "scope": {
    "role": "genius",
    "max_spend_usdc": 5000,
    "expires_in_hours": 24
  }
}
```

Response:
```json
{
  "session_token": "djn_...",
  "expires_at": "2026-03-28T18:00:00Z",
  "scope": { "role": "genius", "max_spend_usdc": 5000 }
}
```

---

## LLM Tool Definitions (Function Calling Schema)

Each endpoint maps to a tool. Example for Claude/OpenAI function calling:

```json
{
  "name": "browse_signals",
  "description": "Browse available signals to purchase. Filter by sport, genius reputation, fee, and notional size. Returns signals sorted by the specified criteria.",
  "parameters": {
    "type": "object",
    "properties": {
      "sport": {
        "type": "string",
        "enum": ["basketball_nba", "icehockey_nhl", "baseball_mlb", "americanfootball_nfl", "soccer_epl"],
        "description": "Filter by sport"
      },
      "genius_address": {
        "type": "string",
        "description": "Filter by specific genius address"
      },
      "min_quality_score": {
        "type": "number",
        "description": "Minimum genius quality score (0-1)"
      },
      "max_fee_bps": {
        "type": "integer",
        "description": "Maximum fee in basis points (e.g., 500 = 5%)"
      },
      "sort": {
        "type": "string",
        "enum": ["quality_score", "fee", "expires_soon", "notional_remaining"],
        "description": "Sort order"
      },
      "limit": {
        "type": "integer",
        "description": "Max results to return"
      }
    }
  }
}
```

```json
{
  "name": "get_network_config",
  "description": "Fetch validator public keys, Shamir parameters, and contract addresses needed by the SDK for signal creation. This data is cached and doesn't change per signal. Call once and reuse.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

```json
{
  "name": "purchase_signal",
  "description": "Purchase a signal as an idiot. Checks availability via MPC, debits escrow, and releases encrypted key shares. The pick must still be available at a sportsbook.",
  "parameters": {
    "type": "object",
    "properties": {
      "signal_id": {
        "type": "string",
        "description": "The signal ID to purchase"
      },
      "notional_usdc": {
        "type": "number",
        "description": "Amount in USDC to wager on this signal"
      }
    },
    "required": ["signal_id", "notional_usdc"]
  }
}
```
