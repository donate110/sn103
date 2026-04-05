# Spec: Off-Chain Decoy Lines (DEV-042)

**Status:** Draft
**Branch:** TBD (off `queue-based-audits`)
**Motivation:** Move decoy lines off-chain to reduce gas costs, enable variable
decoy counts (10 to 1000+), eliminate information leakage, and make the real
pick statistically indistinguishable from decoys even to validators.

## What Changes

Today, `SignalCommitment.commit()` stores a `string[] decoyLines` array on-chain.
Each string is a ~200-byte JSON object. Ten strings cost ~40-60K gas in storage
alone. This makes large decoy sets (50, 100, 1000) prohibitively expensive and
publicly exposes which games/markets a genius is interested in.

After this change, the contract stores only:

- `bytes32 linesHash`: keccak256 of the deterministically-ordered line array
- `uint16 lineCount`: how many lines (1 real + N decoys)

The actual line data lives with validators, who receive it during the existing
Shamir share distribution step. The on-chain hash is a tamper seal.

**Lines are never exposed to any consumer.** No public API endpoint. No browser
display. Lines are a validator-internal audit artifact. Buyers see the genius's
track record, sport, fee, and SLA. After purchase, they see only their decrypted
real pick.

## Privacy Model: Jiggered Lines

All lines (real and decoy) are perturbed ("jiggered") before hashing and
distribution to validators. This prevents even a validator from identifying
the real pick by statistical analysis of the line set.

### How jiggering works

```typescript
function jiggerLine(line: StructuredLine): StructuredLine {
  const jiggered = { ...line };

  // Perturb odds: shift by random amount in [-15, +15] American cents
  // e.g. -110 becomes anywhere from -125 to -95
  const oddsShift = cryptoRandomInt(31) - 15;  // -15 to +15
  if (jiggered.price) {
    jiggered.price = jiggerDecimalOdds(jiggered.price, oddsShift);
  }

  // Perturb spread/total lines: shift by random 0, 0.5, or 1.0 points
  if (jiggered.line !== null) {
    const lineShift = (cryptoRandomInt(5) - 2) * 0.5;  // -1.0 to +1.0
    jiggered.line = jiggered.line + lineShift;
  }

  return jiggered;
}

// Applied to ALL lines, including the real pick
const jiggeredLines = allLines.map(jiggerLine);
const linesHash = computeLinesHash(jiggeredLines.map(serializeLine));
```

### Why this works

- A validator sees 1000 lines, all with slightly off-market prices
- The real pick is perturbed the same way as every decoy
- No line "stands out" as manually adjusted vs. market-derived
- The unperturbed real pick is inside the encrypted blob, used only at audit

### Preflight happens before jiggering

```
1. Genius picks bet, system generates 999 decoys from real odds
2. Miners verify all 1000 UNJIGGERED lines at sportsbooks (preflight)
3. After preflight passes, system jiggers all 1000 lines
4. Jiggered lines are hashed, hash goes on-chain
5. Jiggered lines sent to validators (who never see the clean versions)
6. Encrypted blob contains: { realPick (unjiggered), realIndex }
```

Miners see the real market lines (needed for verification). Validators see
only jiggered lines (for privacy). The hash commits to the jiggered versions.

## Multi-Sport Decoys

To prevent sport-level information leakage, decoys are drawn from ALL
available sports, not just the genius's chosen sport:

```
Genius picks: Lakers ML -110 (basketball_nba)
System fetches: NBA + NFL + NHL + MLB + EPL + ... (8 parallel API calls)
Generates: 999 decoys across all sports
Result: 1000 lines spanning 8 sports, 50+ games
```

The `sport` field on-chain changes to a generic marker or is removed entirely.
The real sport is inside the encrypted blob. A validator looking at 1000 lines
across 8 sports cannot even determine which sport the genius cares about.

### API cost

The Odds API returns all upcoming games per sport in a single call:
```
GET /v4/sports/basketball_nba/odds -> all NBA games, all books, all markets
```

Eight sports = 8 API calls (parallel). Returns hundreds of available bets.
More than enough to fill 999 decoy slots with real, verifiable lines.

## Contract Changes

### IDjinn.sol: Signal struct

```solidity
struct Signal {
    address genius;
    bytes encryptedBlob;
    bytes32 commitHash;
    string sport;            // v2: set to "multi" (real sport in encrypted blob)
    uint256 maxPriceBps;
    uint256 slaMultiplierBps;
    uint256 maxNotional;
    uint256 minNotional;
    uint256 expiresAt;
    // REMOVED: string[] decoyLines;
    // ADDED:
    bytes32 linesHash;
    uint16 lineCount;
    string[] availableSportsbooks;
    SignalStatus status;
    uint256 createdAt;
}
```

### SignalCommitment.sol: CommitParams

```solidity
struct CommitParams {
    uint256 signalId;
    bytes encryptedBlob;
    bytes32 commitHash;
    string sport;
    uint256 maxPriceBps;
    uint256 slaMultiplierBps;
    uint256 maxNotional;
    uint256 minNotional;
    uint256 expiresAt;
    // REMOVED: string[] decoyLines;
    // ADDED:
    bytes32 linesHash;
    uint16 lineCount;
    string[] availableSportsbooks;
}
```

### SignalCommitment.sol: Validation changes

```solidity
// BEFORE:
if (p.decoyLines.length != 10) revert InvalidDecoyLinesLength(p.decoyLines.length);
for (uint256 i; i < len; ++i) {
    if (bytes(p.decoyLines[i]).length > MAX_DECOY_LINE_LENGTH) { ... }
    s.decoyLines.push(p.decoyLines[i]);
}

// AFTER:
if (p.linesHash == bytes32(0)) revert ZeroLinesHash();
if (p.lineCount < 2 || p.lineCount > MAX_LINE_COUNT) revert InvalidLineCount(p.lineCount);
s.linesHash = p.linesHash;
s.lineCount = p.lineCount;
```

New constants:
- `uint16 public constant MIN_LINE_COUNT = 2;` (1 real + 1 decoy minimum)
- `uint16 public constant MAX_LINE_COUNT = 1000;`

### Gas savings

| Decoy count | Before (string[]) | After (hash) | Savings |
|-------------|-------------------|--------------|---------|
| 10          | ~55K gas storage  | ~5K gas      | ~90%    |
| 50          | ~250K gas         | ~5K gas      | ~98%    |
| 100         | ~500K gas         | ~5K gas      | ~99%    |
| 1000        | impossible        | ~5K gas      | N/A     |

## Backward Compatibility (Lazy Migration)

Old signals (v1) have `decoyLines` populated and `linesHash == bytes32(0)`.
New signals (v2) have `linesHash` populated and `decoyLines` empty.

The contract detects which version a signal is based on the linesHash field.
No data migration needed. Old signals continue to work as-is.

```solidity
function isV2Signal(uint256 signalId) public view returns (bool) {
    return _signals[signalId].linesHash != bytes32(0);
}
```

The `getSignal()` return type changes (struct field replacement). This is a
breaking ABI change. All consumers (web client, validator, subgraph ABI) must
update their ABI definitions. The subgraph already ignores decoyLines, so
the only real impact is on the web client and validator chain client.

## Client-Side Hash Computation

The genius's browser computes the hash before submitting the transaction:

```typescript
import { keccak256, AbiCoder } from "ethers";

function computeLinesHash(lines: string[]): string {
  // Lines are in their final order (real pick already inserted at random position)
  // No sorting - the order matters because realIndex references a position
  const encoded = AbiCoder.defaultAbiCoder().encode(["string[]"], [lines]);
  return keccak256(encoded);
}
```

The hash commits to the exact order, so `realIndex` remains meaningful.
Validators verify the hash matches after receiving the lines.

## Off-Chain Storage: Validator Side

### Signal registration (existing endpoint, extended)

The genius already sends Shamir shares to each validator via
`POST /v1/signal/{id}/register`. The request body gains the full line array:

```python
class RegisterSignalRequest(BaseModel):
    sport: str
    event_id: str
    home_team: str
    away_team: str
    lines: list[str] = Field(min_length=2, max_length=1000)  # was exactly 10
    lines_hash: str = ""  # hex-encoded bytes32, for verification
    genius_address: str = ""
    idiot_address: str = ""
    notional: int = 0
    odds: int = 1_000_000
    sla_bps: int = 10_000
    cycle: int = 0
```

Validator verification on receipt:

```python
from eth_abi import encode
from eth_utils import keccak

def verify_lines_hash(lines: list[str], expected_hash: str) -> bool:
    encoded = encode(["string[]"], [lines])
    computed = "0x" + keccak(encoded).hex()
    return computed == expected_hash
```

If `lines_hash` is provided and verification fails, the validator rejects
the registration. If `lines_hash` is empty (v1 signal), skip verification
(backward compat).

### Storage

Validators already persist signal metadata in their local SQLite/JSON store
via `outcome_attestor.register_signal()`. The lines are already stored there.
No new storage infrastructure is needed.

### No public retrieval API

Lines are NOT served to any external consumer. No `GET /lines` endpoint.
Validators use lines internally for audit resolution only. Peer validators
can sync lines for bootstrap (see below), authenticated by validator identity.

## Web Client Changes

### Signal creation flow

1. Genius picks bet, system generates N decoys from ALL sports (8 API calls)
2. Miners verify all N+1 unjiggered lines (preflight, off-chain)
3. System jiggers all lines (random perturbations to odds and spreads)
4. Real pick inserted at random position in jiggered array
5. `linesHash = computeLinesHash(jiggeredSerializedLines)`
6. On-chain: `commit({ ..., linesHash, lineCount: N+1, sport: "multi" })`
7. Distribute jiggered lines to validators with Shamir shares
8. Validators verify hash, store jiggered lines

### Signal display (buyer/genius pages)

Lines are never displayed. The buyer page shows:

```
Signal #1234
Sport: Undisclosed (revealed after purchase)
Lines: 1000 (privacy-enhanced)
Fee: 2.5%  |  SLA: 150%  |  Max: $10,000
Genius track record: 63% win rate, 142 signals
```

After purchase, the buyer sees only their decrypted real pick:
```
Your signal: Lakers ML -110
Game: Lakers @ Warriors, Apr 5 7:30 PM
```

No decoy lines are ever shown to anyone.

### Genius signal detail page

The genius sees their own pick (from localStorage) and signal status.
No decoy line display. The genius created them; reviewing them adds no value.

## Validator Audit Bootstrap Changes

### audit_bootstrap.py

Currently reads decoyLines from on-chain `getSignal()`:

```python
decoy_lines = signal.get("decoyLines", [])
if not decoy_lines or len(decoy_lines) < 10:
    continue
```

After the change, for v2 signals:

```python
lines_hash = signal.get("linesHash", "0x" + "00" * 32)
if lines_hash != "0x" + "00" * 32:
    # v2 signal: lines are in local storage, not on-chain
    stored = outcome_attestor.get_signal_lines(signal_id)
    if not stored:
        # Not in local store; fetch from peer validator (authenticated)
        stored = await fetch_lines_from_peer(signal_id, lines_hash)
    decoy_lines = stored
else:
    # v1 legacy: read from chain
    decoy_lines = signal.get("decoyLines", [])
```

### Peer sync (validator-to-validator only)

When a validator bootstraps and encounters a v2 signal it doesn't have lines
for, it queries peer validators via authenticated validator-to-validator channel:

```python
async def fetch_lines_from_peer(signal_id: str, expected_hash: str) -> list[str]:
    for peer in get_peer_validators():
        try:
            resp = await httpx.get(
                f"{peer}/v1/internal/signal/{signal_id}/lines",
                headers={"X-Validator-Auth": sign_request(signal_id)},
            )
            data = resp.json()
            if verify_lines_hash(data["lines"], expected_hash):
                return data["lines"]
        except Exception:
            continue
    raise LinesNotAvailable(signal_id)
```

The `/v1/internal/` prefix indicates this is a validator-only endpoint,
authenticated by validator identity (Bittensor hotkey signature or similar).

## SDK Changes

### signal.ts

```typescript
// Remove hardcoded count validation
// Before:
if (decoys.length !== 9) throw new Error(`Expected 9 decoys`);

// After:
if (decoys.length < 1) throw new Error("Need at least 1 decoy");

// Jigger all lines before hashing
const jiggeredLines = allLines.map(jiggerLine);
const serializedLines = jiggeredLines.map(l => JSON.stringify(l));
const linesHash = computeLinesHash(serializedLines);

return {
  encryptedBlob,    // contains real (unjiggered) pick + realIndex
  commitHash,
  linesHash,
  lineCount: jiggeredLines.length,
  serializedLines,  // jiggered, for validator distribution
  realIndex,
  shamirShares,
};
```

## Miner Changes

### Preflight verification

Miners verify UNJIGGERED lines before the genius jiggers and commits.
The `CheckRequest` model relaxes its index bounds:

```python
class CheckRequest(BaseModel):
    index: int = Field(ge=1, le=1000)  # was le=10

class BatchCheckRequest(BaseModel):
    lines: list[str] = Field(min_length=1, max_length=1000)  # was max 10
```

Miners see clean market lines during preflight. They never see the jiggered
versions. The jiggering step happens client-side after preflight passes.

### API call efficiency

The miner's Odds API usage mirrors the check-lines endpoint: group candidate
lines by sport, one API call per sport (parallel), match against all events.
1000 lines across 8 sports = 8 API calls, same as checking 10 lines from 1
sport costs 1 API call.

## Subgraph Changes

The subgraph never indexed decoyLines. It only needs to update its ABI to
reflect the new struct shape. The schema.graphql Signal entity gains:

```graphql
type Signal @entity {
  # ... existing fields ...
  linesHash: Bytes!     # NEW
  lineCount: Int!       # NEW
  # REMOVED: decoyLines: [String!]!
}
```

## Variable Decoy Count (User-Facing)

With hash-based storage, decoy count becomes a genius preference. Default
is 999 (1000 total lines). The UI does not expose a decoy count selector
unless we find a reason to. More decoys = strictly better privacy at no
additional gas cost. The only cost is off-chain: more miner preflight work
and more data for validators to store (~200 bytes x 1000 = 200KB per signal).

## Implementation Order

1. **Contract upgrade** (schedule through 72h timelock immediately)
   - Add `linesHash`, `lineCount` fields to Signal struct
   - Add new validation, keep old `decoyLines` field for backward compat
   - Deploy upgraded implementation behind existing proxy

2. **SDK** (no deployment needed, npm package)
   - Add `computeLinesHash()` and `jiggerLine()` functions
   - Remove hardcoded count validation
   - Return linesHash in `encryptSignal()` result

3. **Validator** (deploy to validator nodes)
   - Extend RegisterSignalRequest to accept variable line counts + hash
   - Add hash verification on registration
   - Add authenticated `/v1/internal/signal/{id}/lines` for peer sync
   - Remove any public lines endpoint
   - Update audit_bootstrap for v2 signals

4. **Miner** (deploy to miner nodes)
   - Relax index bounds in CheckRequest
   - No other changes needed

5. **Web client** (deploy to Vercel)
   - Update ABI and types
   - Fetch odds from all 8 sports for decoy generation
   - Compute linesHash client-side after jiggering
   - Pass hash + lineCount to contract (not string array)
   - Send jiggered lines to validators in share distribution step
   - Remove all decoy line display from buyer and genius pages
   - Set sport to "multi" on-chain

6. **Subgraph** (deploy to The Graph)
   - Update ABI
   - Add linesHash, lineCount fields to schema

## Rollback Plan

If issues arise after contract upgrade:
- Old v1 signals are unaffected (backward compat)
- Web client can be reverted to read decoyLines from chain
- Validator can serve lines from local storage regardless of on-chain format
- Contract can be upgraded again to restore string[] if needed (UUPS proxy)

## Security Analysis

### Information visible to each party

| Party          | Before (v1)                                    | After (v2)                          |
|----------------|------------------------------------------------|-------------------------------------|
| **Public**     | 10 plaintext lines, sport, fee, SLA, notional  | lineCount, linesHash, fee, SLA, notional |
| **Validator**  | 10 lines + Shamir shares + encrypted blob      | 1000 jiggered lines + Shamir shares + blob |
| **Miner**      | 10 lines (preflight)                           | 1000 unjiggered lines (preflight only) |
| **Buyer pre**  | 10 lines, sport, genius stats                  | lineCount, genius stats             |
| **Buyer post** | decrypted real pick + 10 lines                 | decrypted real pick only            |

### Validator attack surface

**Before:** A validator sees 10 lines and holds Shamir shares. With k shares
(below threshold), they can't decrypt. But they can analyze 10 lines:
- Statistical: "this line has unusual odds" (1/10 chance of guessing right)
- Temporal: "this line was added last" (if insertion order leaks)

**After:** A validator sees 1000 jiggered lines across 8 sports.
- Statistical: all lines are equally perturbed (1/1000 chance)
- Temporal: all lines are shuffled and jiggered simultaneously
- Sport: real sport is unknown (hidden in encrypted blob)
- Even with the full line set, identifying the real pick is negligible

### Hash collision resistance

keccak256 provides 256-bit collision resistance. An attacker cannot find a
different line set that produces the same hash.

### Validator availability

If all validators that received lines go offline, lines for that signal are
lost. Mitigation: lines can be reconstructed from the genius's local storage
(browser localStorage already saves signal creation data). The genius can
re-distribute to new validators.

### Backward compatibility

v1 signals retain full on-chain decoyLines. No data loss. No migration needed.
