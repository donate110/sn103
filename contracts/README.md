# Djinn Protocol Smart Contracts

## Table of Contents

1. [Protocol Overview](#protocol-overview)
2. [Architecture](#architecture)
3. [Contract Descriptions](#contract-descriptions)
4. [Shared Types and Enums](#shared-types-and-enums)
5. [Fund Flow](#fund-flow)
6. [Access Control](#access-control)
7. [Upgrade Model](#upgrade-model)
8. [Key Constants](#key-constants)
9. [Security Properties](#security-properties)
10. [Testing](#testing)
11. [Deployment](#deployment)

---

## Protocol Overview

Djinn unbundles **information from execution** in sports betting. Analysts ("Geniuses") sell encrypted predictions. Buyers ("Idiots") purchase access to those predictions and execute bets independently at their own sportsbooks. Signals stay encrypted forever; the real prediction is hidden among 10 decoy lines in an AES-256-GCM encrypted blob. Track records are cryptographically verifiable through zero-knowledge proofs.

The protocol is deployed on Base chain and settled in USDC (6 decimals). All financial math operates in USDC's 6-decimal precision.

**Core lifecycle:**

1. A Genius commits an encrypted signal with parameters (sport, price, SLA commitment, notional bounds, expiry).
2. One or more Idiots purchase the signal, paying a fee and specifying their own notional and odds.
3. Bittensor validators (off-chain) observe game outcomes via MPC without revealing which line was the real pick.
4. After 10 signals between a Genius-Idiot pair (one "audit cycle"), settlement occurs: a Quality Score is computed, damages (if any) are distributed, and collateral locks are released.

---

## Architecture

All core contracts use the **UUPS proxy pattern** (OpenZeppelin v5) with a **TimelockController** (72-hour delay) as the owner. This means:

- Every upgradeable contract is deployed behind an `ERC1967Proxy`.
- The `_authorizeUpgrade` function requires `onlyOwner` on all contracts. Contracts holding USDC (Escrow, Collateral, Audit) additionally require `whenPaused`.
- The TimelockController is deployed with a 72-hour minimum delay (`259200` seconds). A multisig address is the sole proposer. Anyone can execute after the delay expires. There is no admin role (self-governing).
- Ownership of all upgradeable contracts is transferred to the TimelockController at deployment time.

**Exception:** `KeyRecovery` is deployed as a plain (non-upgradeable, non-proxy) contract. It holds no funds and has no admin functions.

### Contract Dependency Graph

```
                         +-----------------+
                         | TimelockController |
                         |   (72h delay)      |
                         +--------+--------+
                                  |  owns all contracts
          +-----------+-----------+-----------+-----------+----------+----------+
          |           |           |           |           |          |          |
          v           v           v           v           v          v          v
  SignalCommitment  Escrow   Collateral   Account     Audit   CreditLedger  OutcomeVoting
          ^           |           ^           ^           |          ^          |
          |           |           |           |           |          |          |
          +-----------+           +-----------+-----------+----------+          |
          |  reads signals        |  lock/release/slash   |  mint/burn         |
          |                       |                       |                    |
          +----------- Escrow ----+                       +--- Audit ----------+
                     calls at purchase time                    calls at settlement
```

Cross-contract authorization uses per-contract `authorizedCallers` mappings. Only the owner (TimelockController) can add or remove authorized callers.

---

## Contract Descriptions

### SignalCommitment.sol

**Purpose:** Stores encrypted signal commitments on-chain.

A Genius commits a signal by calling `commit()` with:
- A client-generated `signalId` (uint256, UUID v4 mapped to uint256 for privacy; sequential IDs would leak activity patterns).
- An AES-256-GCM `encryptedBlob` (max 64 KB) containing the real prediction.
- A `commitHash` (bytes32) for future verification.
- 10 `decoyLines` (9 decoys + 1 real), which obscure the actual pick.
- Signal parameters: `sport`, `maxPriceBps` (fee rate, 1-5000 bps), `slaMultiplierBps` (100%-1000%), `maxNotional`, `minNotional`, `expiresAt`.
- A list of `availableSportsbooks` (max 50).

**Signal lifecycle (state machine):**
```
Active --> Cancelled  (by genius via cancelSignal, or by authorized contract)
Active --> Settled    (by authorized contract after audit)
Cancelled --> Settled (existing purchases still settle normally)
Settled               (terminal, no transitions)
```

**Key validations:**
- `slaMultiplierBps` must be between 10,000 (100%) and 100,000 (1000%).
- `maxPriceBps` must be between 1 and 5,000 (0.01% to 50%).
- `expiresAt` must be in the future.
- Exactly 10 decoy lines are required.
- Each decoy line is capped at 1 KB; sport and sportsbook names at 256 bytes each.

### Escrow.sol

**Purpose:** Holds Idiot USDC deposits and processes signal purchases.

**Deposit/Withdraw:** Idiots deposit USDC into their escrow balance before purchasing signals. Withdrawals return unused balance.

**Purchase flow (`purchase()`):**
1. Validates signal is active, not expired, and the buyer is not the genius.
2. Enforces one purchase per Idiot per signal (`hasPurchased` mapping).
3. Validates notional is within signal's min/max bounds and global bounds (1 USDC to 1M USDC).
4. Validates odds are within range (1.01x to 1000x, in 6-decimal precision).
5. Computes fee: `notional * maxPriceBps / 10_000`.
6. Splits fee between credits (burned first) and USDC (deducted from escrow balance).
7. Records the purchase with an auto-incrementing `purchaseId`.
8. Tracks cumulative `signalNotionalFilled` against the signal's `maxNotional`.
9. Accumulates USDC fees in a per-genius-idiot-cycle `feePool`.
10. Locks genius collateral: `notional * slaMultiplierBps / 10_000 + notional * 50 / 10_000` (SLA lock + 0.5% protocol fee lock).
11. Records the purchase in the Account contract.

**Fee claims:** After a cycle is settled, the Genius can claim accumulated USDC fees via `claimFees()` or `claimFeesBatch()`. A 48-hour monitoring delay (`FEE_CLAIM_DELAY`) applies after settlement before fees become claimable, giving the protocol team time to detect and respond to incorrect settlements.

**Outcome recording:** Authorized callers (oracle adapters, validator bridges) can set purchase outcomes via `setOutcome()`. This syncs outcomes to both Escrow and Account.

**Key design decision:** Odds are buyer-chosen, not genius-specified. The buyer executes at their own sportsbook where available odds may differ. The Quality Score formula is intentionally asymmetric: favorable outcomes credit the actual value delivered, while unfavorable outcomes apply a fixed SLA penalty independent of odds.

### Collateral.sol

**Purpose:** Holds Genius USDC collateral to cover worst-case damages on active signals.

**Deposit/Withdraw:** Geniuses deposit USDC collateral. Withdrawals are limited to free (unlocked) collateral: `available = deposits - locked`.

**Lock/Release:** At purchase time, Escrow locks collateral equal to the SLA obligation plus protocol fee. At settlement, Audit releases these locks before distributing damages. Locks are tracked both per-genius (aggregate) and per-genius-per-signal (granular).

**Slash:** The Audit contract can slash genius collateral to pay damages (Tranche A) or protocol fees. `slash()` returns the actual amount slashed, which may be less than requested if deposits are insufficient. Signal locks must be released before slashing to maintain accounting invariants.

**Withdrawal freeze:** During settlement, the Audit contract freezes genius withdrawals to prevent front-running collateral extraction. Withdrawals are unfrozen after settlement completes.

### Account.sol

**Purpose:** Tracks the relationship state between each Genius-Idiot pair across audit cycles.

The primary key is `(genius, idiot)`, hashed via `keccak256(abi.encode(genius, idiot))`.

**Cycle mechanics:**
- Each pair progresses through independent audit cycles.
- Each cycle holds up to `SIGNALS_PER_CYCLE` (10) purchases.
- When the 10th purchase is recorded, the pair becomes "audit-ready."
- After settlement, `settleAudit()` resets the cycle: increments `currentCycle`, zeroes `signalCount` and `outcomeBalance`, clears purchase records and outcomes.

**State tracked per pair:**
- `currentCycle`: Current audit cycle number (starts at 0).
- `signalCount`: Number of purchases recorded in the current cycle.
- `outcomeBalance`: Running tally of outcomes (+1 favorable, -1 unfavorable, 0 void).
- `purchaseIds`: Array of purchase IDs in the current cycle.
- `settled`: Whether the current cycle has been settled.

**Active pair tracking:** `activePairCount` tracks how many pairs have at least one purchase in their current cycle. Incremented on first purchase, decremented on settlement.

### Audit.sol

**Purpose:** Settlement engine. Computes Quality Scores, distributes damages, and manages cycle transitions.

**Quality Score computation (`computeScore()`):**

For each purchase in the cycle:
- **Favorable:** `+notional * (odds - 1e6) / 1e6`
- **Unfavorable:** `-notional * slaMultiplierBps / 10_000`
- **Void/Pending:** Skip (no effect)

The score is bounded by `MAX_QUALITY_SCORE` (1 billion USDC) to prevent overflow.

**Settlement paths:**

1. **Standard settlement (`settle()` / `trigger()`):** Permissionless. Any address can call once the pair is audit-ready (10 signals) and all outcomes are finalized. Computes on-chain Quality Score from recorded outcomes.

2. **Voted settlement (`settleByVote()`):** Called by OutcomeVoting when 2/3+ validators agree on an aggregate quality score. The score is computed off-chain via MPC. Individual purchase outcomes are never written on-chain (privacy preservation).

3. **Early exit (`earlyExit()`):** Either party can trigger before 10 signals. All damages are paid as Credits only (no USDC movement), since the sample size is insufficient for USDC settlement. The 0.5% protocol fee is still charged to prevent fee dodging.

4. **Voted early exit (`earlyExitByVote()`):** Same as voted settlement but for early exits.

5. **Force settlement (`forceSettle()`):** Owner-only (TimelockController) emergency settlement for stuck or orphaned cycles.

**Damage distribution (negative Quality Score):**

- **Tranche A (USDC):** Genius collateral is slashed and sent directly to the Idiot. Capped at the total USDC fees the Idiot paid in this cycle. Per the whitepaper: "You can never extract more USDC than you put in."
- **Tranche B (Credits):** Excess damages beyond the Tranche A cap are minted as non-transferable Djinn Credits to the Idiot. If a collateral slash returns less than intended, the shortfall moves from Tranche A to Tranche B.
- **Protocol Fee:** 0.5% of total notional, slashed from genius collateral to the protocol treasury.

**Settlement sequence:**
1. Freeze genius withdrawals.
2. Compute protocol fee (0.5% of total non-void notional).
3. Release all signal collateral locks for purchases in the cycle.
4. If score < 0: distribute damages (Tranche A USDC + Tranche B Credits).
5. Slash protocol fee from collateral to treasury.
6. Store `AuditResult` (qualityScore, trancheA, trancheB, protocolFee, timestamp).
7. Unfreeze genius withdrawals.
8. Advance the Account to the next cycle.

### OutcomeVoting.sol

**Purpose:** On-chain aggregate voting for signal outcomes via validator consensus.

Validators independently compute quality scores off-chain using MPC (multi-party computation), then vote on the aggregate result on-chain. Individual purchase outcomes never go on-chain, preventing retroactive identification of real picks from on-chain data.

**Voting mechanics:**
- Each validator submits a vote via `submitVote(genius, idiot, qualityScore)`.
- Votes are tracked per `(genius, idiot, cycle)` tuple.
- Each validator can vote once per cycle.
- When 2/3+ validators agree on the same quality score, settlement is triggered automatically by calling `Audit.settleByVote()` or `Audit.earlyExitByVote()`.

**Validator management:**
- Owner (TimelockController) can add/remove validators for bootstrap and emergencies.
- Validators can propose a full set replacement via `proposeSync()`. When 2/3+ of current validators propose the same sorted set at the same nonce, the set is atomically replaced.
- Minimum 3 validators required at all times.
- The `syncNonce` increments on every validator set change to prevent stale proposals.

**Anti-manipulation:**
- `cycleValidatorSnapshot`: Snapshots the validator count when the first vote is cast for a cycle, preventing quorum manipulation by adding/removing validators mid-vote.
- `cycleSyncNonce`: If the validator set changes after the first vote, the cycle resets for re-voting.

**Early exit requests:**
- Either party (Genius or Idiot) can call `requestEarlyExit()` to flag a cycle for early exit.
- Validators then vote on the quality score. If quorum is reached and the cycle has fewer than 10 signals, settlement uses the early exit path (Credits only).

### CreditLedger.sol

**Purpose:** Non-transferable, non-cashable protocol credits used as fee discounts.

Credits are minted as Tranche B during negative audit settlements and burned by Escrow when an Idiot uses them to offset a purchase fee. This is intentionally NOT an ERC20. Credits cannot be transferred, approved, or redeemed for cash. They exist solely to give Idiots partial compensation for poor genius performance, applied as discounts on future signal purchases.

**Functions:**
- `mint(to, amount)`: Called by Audit during settlement.
- `burn(from, amount)`: Called by Escrow during purchase.
- `balanceOf(account)`: Returns credit balance.

### TrackRecord.sol

**Purpose:** Stores ZK-verified track record proofs submitted by Geniuses.

Each proof demonstrates aggregate performance statistics (total signals, gains, losses, favorable/unfavorable/void counts) without revealing individual signal details. Proofs are Groth16 proofs verified on-chain via the ZKVerifier contract.

**Commit-reveal pattern (anti-front-running):**
1. Genius calls `commitProof(commitHash)` where `commitHash = keccak256(abi.encodePacked(_pA, _pB, _pC, _pubSignals))`.
2. At least 1 block later (but within `COMMIT_EXPIRY_BLOCKS` = 32 blocks, roughly 96 seconds on Base), the genius calls `submit()` with the proof.
3. The commitment is cleared after use to prevent replay.

**Public signals layout (106 elements):**
- `[0..19]` commitHash: Poseidon hashes of (preimage, index) for each signal.
- `[20..39]` outcome: 1=Favorable, 2=Unfavorable, 3=Void.
- `[40..59]` notional: Bet amounts.
- `[60..79]` odds: 6-decimal fixed point.
- `[80..99]` slaBps: SLA basis points.
- `[100]` signalCount (1..20).
- `[101..105]` Aggregate statistics: totalGain, totalLoss, favCount, unfavCount, voidCount.

**Deduplication:** Proof hashes are tracked to prevent duplicate submissions.

### KeyRecovery.sol

**Purpose:** Stores encrypted wallet recovery blobs for users.

Users encrypt their signal decryption keys to their wallet public key and store the blob on-chain (max 4 KB). This enables key recovery from any device: the user logs in with their wallet, retrieves the blob, and decrypts locally. The blob is encrypted, so reading it reveals nothing without the wallet's private key.

This is a plain (non-upgradeable) contract with no admin functions. Only `msg.sender` can store their own blob. Anyone can read any blob.

### ZKVerifier.sol

**Purpose:** Routes ZK proof verification to the appropriate snarkjs-generated Groth16 verifier contract.

Acts as an abstraction layer over the circuit-specific verifiers:
- `verifyAuditProof()`: Delegates to `Groth16AuditVerifier` (52 public signals).
- `verifyTrackRecordProof()`: Delegates to `Groth16TrackRecordVerifier` (106 public signals).

The verifier addresses are set by the owner post-deployment. Uses `staticcall` to the generated verifiers.

### Groth16AuditVerifier.sol / Groth16TrackRecordVerifier.sol

**Purpose:** Auto-generated Groth16 verifier contracts produced by snarkjs from circom circuits.

These implement the BN254 elliptic curve pairing check for Groth16 proofs. They are generated code. Auditors should verify that:
- The verification key constants match the trusted setup ceremony output.
- The `verifyProof` function signature matches what `ZKVerifier` expects.

---

## Shared Types and Enums

Defined in `interfaces/IDjinn.sol`:

```solidity
enum Outcome { Pending, Favorable, Unfavorable, Void }

enum SignalStatus { Active, Cancelled, Settled }

struct Signal {
    address genius;
    bytes encryptedBlob;
    bytes32 commitHash;
    string sport;
    uint256 maxPriceBps;       // Fee rate in basis points (1-5000)
    uint256 slaMultiplierBps;  // SLA commitment (10000-100000, i.e., 100%-1000%)
    uint256 maxNotional;       // Maximum total notional across all buyers
    uint256 minNotional;       // Minimum notional per purchase
    uint256 expiresAt;         // Unix timestamp
    string[] decoyLines;       // Always 10 entries
    string[] availableSportsbooks;
    SignalStatus status;
    uint256 createdAt;
}

struct Purchase {
    address idiot;
    uint256 signalId;
    uint256 notional;    // Reference amount in USDC (6 decimals)
    uint256 feePaid;     // Total fee (credit + USDC)
    uint256 creditUsed;  // Portion of fee offset by credits
    uint256 usdcPaid;    // Portion of fee paid in USDC
    uint256 odds;        // Decimal odds * 1e6 (e.g., 1.91 = 1_910_000)
    Outcome outcome;
    uint256 purchasedAt;
}

struct AccountState {
    uint256 currentCycle;
    uint256 signalCount;
    int256 outcomeBalance;  // +1 favorable, -1 unfavorable
    uint256[] purchaseIds;
    bool settled;
}
```

---

## Fund Flow

```
IDIOT                          ESCROW                         GENIUS
  |                              |                              |
  |-- deposit(USDC) ----------->|                              |
  |                              |                              |
  |                              |                 COLLATERAL   |
  |                              |                     |        |
  |                              |<-------- deposit(USDC) -----|
  |                              |                     |        |
  |-- purchase(signal, notional, odds) -->             |        |
  |                              |                     |        |
  |   deduct fee from balance    |                     |        |
  |   burn credits if available  |                     |        |
  |   accumulate USDC in feePool |                     |        |
  |                              |-- lock(collateral) ->        |
  |                              |-- recordPurchase -->ACCOUNT  |
  |                              |                              |
  |                              |                              |
  |   ... 10 signals complete ...                               |
  |                              |                              |
  |                           AUDIT                             |
  |                              |                              |
  |   computeScore() -----------|                               |
  |                              |                              |
  |   IF score < 0:              |                              |
  |     release signal locks ----|-> COLLATERAL                 |
  |     Tranche A: slash USDC ---|-> directly to Idiot wallet   |
  |     Tranche B: mint credits -|-> CREDIT_LEDGER -> Idiot     |
  |     protocol fee: slash -----|-> TREASURY                   |
  |                              |                              |
  |   IF score >= 0:             |                              |
  |     release signal locks ----|-> COLLATERAL                 |
  |     protocol fee: slash -----|-> TREASURY                   |
  |     Genius keeps all fees    |                              |
  |                              |                              |
  |                              |<--- claimFees() (after 48h) -|
  |                              |--- transfer USDC ----------->|
```

### Key Fund Flow Properties

- Idiot USDC enters through `Escrow.deposit()` and exits through `Escrow.withdraw()` (unused balance) or `Collateral.slash()` to the Idiot (Tranche A damages).
- Genius USDC enters through `Collateral.deposit()` and exits through `Collateral.withdraw()` (free collateral), `Collateral.slash()` to the Idiot (damages), `Collateral.slash()` to treasury (protocol fee), or `Escrow.claimFees()` (earned fees from the Escrow fee pool).
- Tranche A damages go directly from Collateral to the Idiot's wallet (not back through Escrow).
- Credits are purely virtual (minted/burned in CreditLedger, never backed by USDC).

---

## Access Control

### Owner: TimelockController

All upgradeable contracts are owned by a single `TimelockController` with:
- **Delay:** 72 hours (259,200 seconds).
- **Proposer:** Multisig address (single proposer configured at deployment).
- **Executor:** `address(0)`, meaning anyone can execute a queued proposal after the delay.
- **Admin:** None (`address(0)`). The TimelockController is self-governing.

Owner-restricted operations include: upgrading contracts, setting contract addresses, managing authorized callers, adding/removing validators, setting the protocol treasury, unpausing, and `forceSettle()`.

### Pauser

Each pausable contract has a dedicated `pauser` address that can call `pause()`. Both the pauser and the owner can pause. Only the owner can unpause. The pauser address is set by the owner via `setPauser()`. Setting the pauser to `address(0)` disables the dedicated pauser role (owner can still pause).

### Authorized Callers (Cross-Contract)

Contracts authorize each other for specific cross-contract calls:

| Caller | Authorized On | Can Call |
|--------|--------------|---------|
| Escrow | Collateral | `lock()` |
| Escrow | CreditLedger | `burn()` |
| Escrow | Account | `recordPurchase()` |
| Escrow | SignalCommitment | `updateStatus()` |
| Audit | Collateral | `lock()`, `release()`, `slash()`, `freezeWithdrawals()`, `unfreezeWithdrawals()` |
| Audit | CreditLedger | `mint()` |
| Audit | Account | `recordOutcome()`, `settleAudit()`, `setSettled()`, `startNewCycle()` |
| OutcomeVoting | Audit | `settleByVote()`, `earlyExitByVote()` (via dedicated `outcomeVoting` address check) |

### Permissionless Functions

- `Audit.settle()` / `Audit.trigger()`: Anyone can trigger settlement once a pair is audit-ready and all outcomes are finalized.
- `Escrow.purchase()`: Any address (except the genius) can purchase a signal.
- `SignalCommitment.commit()`: Any address can commit a signal.
- `KeyRecovery.storeRecoveryBlob()`: Any address can store their own recovery blob.
- `TrackRecord.commitProof()` / `TrackRecord.submit()`: Any address can submit track record proofs.

---

## Upgrade Model

All upgradeable contracts use the UUPS (Universal Upgradeable Proxy Standard) pattern from OpenZeppelin v5.

**`_authorizeUpgrade` requirements per contract:**

| Contract | Requirement |
|----------|-------------|
| SignalCommitment | `onlyOwner` |
| Escrow | `onlyOwner` + `whenPaused` |
| Collateral | `onlyOwner` + `whenPaused` |
| Audit | `onlyOwner` + `whenPaused` |
| Account | `onlyOwner` |
| CreditLedger | `onlyOwner` |
| OutcomeVoting | `onlyOwner` + `whenPaused` |
| ZKVerifier | `onlyOwner` |
| TrackRecord | `onlyOwner` |

Contracts that hold USDC (Escrow, Collateral) or orchestrate USDC movement (Audit) require the contract to be paused before an upgrade can be authorized. This prevents upgrades while funds are in active transit.

**Storage gaps:** Every upgradeable contract reserves a `__gap` array for future storage variables. Gap sizes vary by contract (33 to 48 slots) to bring total storage slots to a consistent ceiling.

**Upgrade scripts:** `script/Upgrade.s.sol` and `script/ExecuteUpgrade.s.sol` handle proposal-based upgrades through the TimelockController. Contract-specific redeploy scripts (`RedeployAccount.s.sol`, `RedeployEscrow.s.sol`) are also provided.

---

## Key Constants

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `SIGNALS_PER_CYCLE` | 10 | Account | Max signals per genius-idiot pair per audit cycle |
| `PROTOCOL_FEE_BPS` | 50 (0.5%) | Audit | Protocol fee on total notional at settlement |
| `BPS_DENOMINATOR` | 10,000 | Audit | Basis points denominator |
| `MAX_QUALITY_SCORE` | 1,000,000,000e6 (1B USDC) | Audit | Bounds check to prevent int256 overflow |
| `ODDS_PRECISION` | 1e6 | Escrow, Audit | 6-decimal fixed point for odds (1.91 = 1,910,000) |
| `MIN_ODDS` | 1,010,000 (1.01x) | Escrow | Minimum allowed odds |
| `MAX_ODDS` | 1,000,000,000 (1000x) | Escrow | Maximum allowed odds |
| `MIN_NOTIONAL` | 1e6 (1 USDC) | Escrow | Minimum notional per purchase |
| `MAX_NOTIONAL` | 1e12 (1M USDC) | Escrow | Maximum notional per purchase |
| `FEE_CLAIM_DELAY` | 48 hours | Escrow | Monitoring delay after settlement before fees are claimable |
| `MAX_BLOB_SIZE` | 65,536 (64 KB) | SignalCommitment | Maximum encrypted blob size |
| `MAX_SPORTSBOOKS` | 50 | SignalCommitment | Maximum sportsbooks per signal |
| `MAX_DECOY_LINE_LENGTH` | 1,024 (1 KB) | SignalCommitment | Maximum length per decoy line |
| `COMMIT_EXPIRY_BLOCKS` | 32 (~96s on Base) | TrackRecord | Window for commit-reveal proof submission |
| `MAX_BLOB_SIZE` (recovery) | 4,096 (4 KB) | KeyRecovery | Maximum recovery blob size |
| `QUORUM_NUMERATOR/DENOMINATOR` | 2 / 3 | OutcomeVoting | 2/3 supermajority quorum |
| `MIN_VALIDATORS` | 3 | OutcomeVoting | Minimum validator set size |
| TimelockController delay | 259,200s (72h) | Deploy.s.sol | Governance delay for owner operations |

---

## Security Properties

### Reentrancy Protection

- Escrow, Collateral, Audit, and OutcomeVoting use OpenZeppelin's `ReentrancyGuard` (v5, namespaced storage slot, proxy-safe without an upgradeable variant).
- All external functions that transfer USDC or modify critical state are protected with `nonReentrant`.
- Escrow follows the Checks-Effects-Interactions (CEI) pattern: state changes are finalized before external calls.

### Pause Mechanism

- All contracts with financial operations implement `PausableUpgradeable`.
- Both the dedicated `pauser` and the `owner` (TimelockController) can pause.
- Only the owner can unpause (prevents a compromised pauser from toggling).
- Pause blocks: deposits, withdrawals, purchases, signal commitments, settlements, and voting.

### Front-Running Mitigations

- **Signal IDs:** Client-generated random 256-bit IDs prevent front-running with predictable sequential IDs.
- **Track record proofs:** Commit-reveal pattern with block-based timing prevents proof front-running.
- **Collateral withdrawals:** Frozen during settlement to prevent extraction before slashing.

### Self-Purchase Prevention

- `Escrow.purchase()` reverts if `sig.genius == msg.sender`.
- Account contract validates `genius != idiot` in all pair operations.

### One-Purchase-Per-Signal-Per-Idiot

- `Escrow.hasPurchased[signalId][msg.sender]` prevents duplicate purchases.

### Upgrade Safety

- Contracts holding USDC require `whenPaused` for upgrade authorization.
- TimelockController enforces a 72-hour delay on all owner operations, providing time to detect and respond to malicious upgrade proposals.

---

## Testing

The test suite uses Foundry and includes unit tests, integration tests, and fuzz tests.

**Test files:**

| File | Description |
|------|-------------|
| `Account.t.sol` | Account cycle management, purchase recording, pair validation |
| `Audit.t.sol` | Quality score computation, settlement, tranche distribution |
| `Audit.fuzz.sol` | Fuzz tests for quality score computation |
| `Collateral.t.sol` | Deposit, withdraw, lock, release, slash mechanics |
| `CreditLedger.t.sol` | Credit mint/burn, authorization |
| `Escrow.t.sol` | Deposit, withdraw, purchase flow, fee claims |
| `Escrow.fuzz.sol` | Fuzz tests for purchase math |
| `FuzzFinancialMath.t.sol` | Cross-contract fuzz tests for financial calculations |
| `KeyRecovery.t.sol` | Blob storage and retrieval |
| `Lifecycle.t.sol` | Full protocol lifecycle integration tests |
| `OutcomeVoting.t.sol` | Validator voting, quorum, sync |
| `OutcomeVotingSync.t.sol` | Validator set synchronization |
| `Pausable.t.sol` | Pause/unpause behavior across all contracts |
| `Reentrancy.t.sol` | Reentrancy attack resistance |
| `SafetyFeatures.t.sol` | Safety invariants and edge cases |
| `SignalCommitment.t.sol` | Signal commit, cancel, status transitions |
| `TrackRecord.t.sol` | ZK proof submission and verification |
| `ZKVerifier.t.sol` | Verifier routing |
| `EdgeCases.t.sol` | Boundary conditions and corner cases |

**Configuration** (from `foundry.toml`):
- Fuzz runs: 1,000 per test (configurable via `FOUNDRY_FUZZ_RUNS`).
- Invariant runs: 256 with depth 50.
- Solidity compiler: 0.8.28 with optimizer enabled (200 runs).

```shell
# Run all tests
forge test

# Run with verbosity
forge test -vvv

# Run specific test file
forge test --match-path test/Audit.t.sol

# Run fuzz tests with more runs
FOUNDRY_FUZZ_RUNS=10000 forge test --match-test testFuzz

# Gas report
forge test --gas-report
```

---

## Deployment

### Initial Deployment

The `Deploy.s.sol` script handles the complete deployment:

1. Deploys USDC (MockUSDC on testnet, uses real USDC on mainnet at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
2. Deploys all implementation contracts and wraps them in `ERC1967Proxy` instances.
3. Wires cross-contract references (Audit to Escrow, Escrow to Collateral, etc.).
4. Sets up authorized callers for cross-contract calls.
5. Configures the pauser address on all pausable contracts.
6. Deploys a `TimelockController` (72h delay, multisig as proposer, anyone as executor).
7. Transfers ownership of all contracts to the TimelockController.
8. Runs a comprehensive verification pass to confirm all wiring, authorization, pauser, and ownership settings.

```shell
# Set environment variables
cp .env.example .env
# Edit .env with DEPLOYER_KEY, PROTOCOL_TREASURY, MULTISIG_ADDRESS, PAUSER_ADDRESS

# Deploy to Base Sepolia
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

### Post-Deployment Upgrades

Upgrades go through the TimelockController:

1. Deploy the new implementation contract.
2. Propose the `upgradeToAndCall()` transaction via the TimelockController (72h delay).
3. After the delay, anyone can execute the queued upgrade.

See `script/Upgrade.s.sol` and `script/ExecuteUpgrade.s.sol` for the upgrade workflow.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DEPLOYER_KEY` | Private key of the deployer account |
| `PROTOCOL_TREASURY` | Address that receives the 0.5% protocol fee (defaults to deployer) |
| `MULTISIG_ADDRESS` | Proposer for the TimelockController (defaults to deployer) |
| `PAUSER_ADDRESS` | Emergency pauser address (defaults to deployer) |
| `BASE_SEPOLIA_RPC_URL` | RPC endpoint for Base Sepolia |
| `BASESCAN_API_KEY` | API key for contract verification on BaseScan |
