# Djinn Protocol: Smart Contract Security Audit Report

**Methodology:** Trail of Bits "Building Secure Contracts" Framework
**Date:** 2026-03-26
**Contracts:** 8 Solidity files in `contracts/src/`
**Solidity:** 0.8.28 | **OpenZeppelin:** v5.5.0 | **Tests:** 371/371 passing
**Tools:** Slither 0.11.5, Foundry, manual review

---

## Executive Summary

The Djinn Protocol smart contracts are well-engineered with strong security practices. The codebase consistently follows the Checks-Effects-Interactions (CEI) pattern, uses OpenZeppelin's latest v5.5.0 libraries, employs UUPS proxies with proper initialization guards and storage gaps summing to 50 slots each, and includes comprehensive NatSpec documentation. The test suite is thorough with 371 passing tests including unit, integration, fuzz, lifecycle, edge case, reentrancy, and pausable coverage.

**Overall assessment: The contracts are suitable for testnet/beta use. Immediate remediation items have been applied (see Remediation Status below). Remaining items should be addressed before mainnet deployment.**

### Remediation Status (2026-03-26)

The following immediate fixes were applied:

| Finding | Fix | Status |
|---------|-----|--------|
| H-1: ReentrancyGuardTransient | **False positive.** OZ v5.5.0 has no `ReentrancyGuardUpgradeable`; `ReentrancyGuardTransient` is `@custom:stateless` (fixed hash slot, no sequential storage), recommended for proxies, and replaces `ReentrancyGuard` in v6. | N/A |
| H-2: CreditLedger pause bypass | Added `whenNotPaused` to `mint()` and `burn()` | FIXED |
| L-4: renounceOwnership bricking | Added `pure override` that reverts in all 7 upgradeable contracts | FIXED |
| C-2: Dispute resolution absent | Added DEV-029 to DEVIATIONS.md documenting status and recourse mechanisms | FIXED |
| M-5: reduceFeePool no reentrancy guard | Added `nonReentrant` to `Escrow.reduceFeePool()` | FIXED |
| L-1: setPauser zero-check | **False positive.** NatSpec documents `address(0) to disable`; zero address is intentional design for removing the pauser role. | N/A |

### Finding Summary

| Severity | Count | Description |
|----------|-------|-------------|
| CRITICAL | 2 | Spec compliance: ZK settlement model removed, dispute resolution absent (C-2 documented) |
| HIGH | 4 | ~~ReentrancyGuardTransient (false positive)~~, ~~CreditLedger pause bypass (FIXED)~~, buyer-supplied odds manipulation, validator vote integrity |
| MEDIUM | 8 | forceSettle centralization, permissionless signal creation, stale outcome data, ~~reduceFeePool (FIXED)~~, storage gap documentation, others |
| LOW | 9 | ~~Missing zero-checks (false positive)~~, event gaps, KeyRecovery not upgradeable, ~~renounceOwnership (FIXED)~~, timing edge cases |
| INFO | 6 | NatSpec quality (excellent), test suite (strong), front-running (mitigated) |

---

## 1. Attack Surface Map

### Entry Point Statistics

| Metric | Count |
|--------|-------|
| Total state-changing entry points | 117 |
| Public (Unrestricted) | 14 |
| Public (Logic-restricted, e.g., msg.sender == party) | 3 |
| Role-Restricted (onlyOwner, via TimelockController 72h) | 56 |
| Role-Restricted (pauser OR owner) | 7 |
| Role-Restricted (validator-only) | 2 |
| Contract-Only (onlyAuthorized / msg.sender == specific) | 14 |
| Inherited (upgradeToAndCall, transferOwnership, renounceOwnership) | 21 |

### Per-Contract Breakdown

| Contract | Total | Unrestricted | Owner | Contract-Only | Inherited |
|----------|-------|-------------|-------|---------------|-----------|
| Account.sol | 13 | 0 | 5 | 5 | 3 |
| Audit.sol | 20 | 3 | 11 | 3 | 3 |
| Collateral.sol | 17 | 2 | 6 | 5 | 4 |
| CreditLedger.sol | 10 | 0 | 5 | 2 | 3 |
| Escrow.sol | 21 | 4 | 8 | 3 | 6 |
| KeyRecovery.sol | 1 | 1 | 0 | 0 | 0 |
| OutcomeVoting.sol | 15 | 1 | 6 | 0 | 8 |
| SignalCommitment.sol | 12 | 2 | 6 | 1 | 3 |

### Most Security-Sensitive Functions

| # | Function | Risk | Why |
|---|----------|------|-----|
| 1 | `Collateral.slash()` | Direct fund movement | Transfers USDC to arbitrary recipient; protected only by `onlyAuthorized` |
| 2 | `Audit.forceSettle()` | Arbitrary settlement | Owner picks qualityScore; can drain genius collateral |
| 3 | `Audit.settleByVote()` | Validator-dependent | Accepts validator-voted score; malicious OutcomeVoting = arbitrary settlement |
| 4 | `Escrow.purchase()` | Core USDC movement | Burns credits, locks collateral, records purchases; buyer-chosen odds affect quality score |
| 5 | All `upgradeToAndCall()` | Implementation replacement | 7 contracts can be fully replaced; mitigated by onlyOwner + whenPaused |
| 6 | All `renounceOwnership()` | Irreversible bricking | Permanently removes owner; no upgrades, no parameter changes possible |
| 7 | `Audit.setProtocolTreasury()` | Fee redirection | Redirects protocol fees to arbitrary address |
| 8 | `OutcomeVoting.proposeSync()` | Validator set replacement | 2/3 colluding validators can install fully malicious validator set |

---

## 2. Slither Automated Analysis

Slither 0.11.5 completed successfully. Key findings:

### Uninitialized Local Variables (Informational)
- `Audit._settleCommon`: `trancheA`, `trancheB` (L631-632) -- intentional; set conditionally
- `Audit.forceSettle`: `totalNotional`, `totalUsdcFeesPaid` (L454-455) -- intentional; accumulated in loop
- `SignalCommitment.commit`: `available` (L234) -- intentional; set by staticcall result
- `Escrow.claimFeesBatch`: `total` (L452) -- intentional; accumulated

**Assessment:** All are intentional patterns (accumulator variables, conditionally-set values). No action needed.

### Missing Zero-Address Checks
All 7 `setPauser()` functions and `SignalCommitment.setCollateral()` lack zero-address validation.

**Assessment:** LOW. The owner (TimelockController) would need to deliberately set address(0). Adding `require(_pauser != address(0))` is trivial defense-in-depth.

### Calls Inside Loops
`Audit.computeScore()`, `_aggregatePurchases()`, `_releaseSignalLocks()`, `_settleInternal()`, and `Escrow.claimFeesBatch()` make external calls in loops.

**Assessment:** LOW (mitigated). All loops are bounded: max 10 iterations (SIGNALS_PER_CYCLE) for Audit functions, max 100 for `claimFeesBatch`. Gas cost is predictable and bounded.

### Benign Reentrancy
`Audit._settleCommon()` writes `auditResults` after external calls to Collateral and CreditLedger.

**Assessment:** LOW (mitigated). The function has `nonReentrant` on all entry points (`settle`, `settleByVote`, `forceSettle`). The state write after external calls is safe because reentrancy is blocked.

### Timestamp Dependence
Signal expiration and fee claim timing use `block.timestamp`.

**Assessment:** INFO. Timestamp manipulation by miners is bounded to ~15 seconds on Base. The protocol's time windows (48h fee claim delay, signal expiry) are orders of magnitude larger than possible manipulation.

---

## 3. Key Findings

### CRITICAL

#### C-1: Settlement Trust Model Changed from ZK to Validator Voting (Spec Compliance)

**Spec:** Whitepaper Section 6: "The client application generates a ZK proof of the Quality Score. The proof demonstrates correct computation from committed signals and public outcomes, without revealing any signal. The smart contract verifies the proof and settles."

**Code:** Settlement is performed via `Audit.settle()` (permissionless on-chain path) or `Audit.settleByVote()` (2/3+ validator consensus). No ZK verifier contract exists. No proof generation or verification code.

**Deviation:** Documented in DEV-015: "ZK proofs are useful when you need to prove a statement without revealing the underlying data. But the aggregate audit results are already public on-chain."

**Risk:** The whitepaper's trust model is cryptographic (ZK proofs are self-verifying). The implementation's trust model is economic (2/3+ validator honesty). A colluding validator majority can fabricate settlement outcomes. The whitepaper should be updated to reflect the actual trust model.

**Severity:** CRITICAL (trust model change)
**Remediation:** Update whitepaper Sections 3, 6, 8 to describe the validator voting model. Document the trust assumptions explicitly.

#### C-2: Dispute Resolution System Absent (Spec Compliance)

**Spec:** Whitepaper Section 12 describes: outcome disputes with staked challenges, 48h finalization windows, validator re-arbitration, and escalation to Yuma consensus. Score disputes use ZK re-computation.

**Code:** No dispute resolution contract exists. No staking mechanism. No challenge/response flow. The only recovery is `Audit.forceSettle()` via 72h timelock or `OutcomeVoting.resetCycle()`.

**Deviation:** Not documented in DEVIATIONS.md.

**Severity:** CRITICAL (missing security feature)
**Remediation:** Either implement dispute resolution or add a DEVIATIONS.md entry explaining why it is deferred and what the current recourse mechanism is (forceSettle via timelock).

---

### HIGH

#### H-1: ReentrancyGuardTransient in Proxy Contracts

**Files:** Audit.sol:26, Collateral.sol:16, Escrow.sol:19, OutcomeVoting.sol:27

**Description:** Four contracts inherit `ReentrancyGuardTransient` (non-upgradeable, from `@openzeppelin/contracts/`) instead of `ReentrancyGuardUpgradeable`. This uses EIP-1153 transient storage (`TSTORE`/`TLOAD`), which currently avoids storage layout conflicts but:
- Locks deployment to EVM chains supporting EIP-1153 (Dencun+)
- If a future OZ version changes the implementation to use regular storage, upgrading the dependency would silently break proxy storage layout
- Violates the canonical proxy safety guideline that all base contracts in a proxy must use the upgradeable variant

**Remediation:** Switch to `ReentrancyGuardUpgradeable` from `@openzeppelin/contracts-upgradeable/` and add `__ReentrancyGuard_init()` in each initializer.

#### H-2: CreditLedger mint/burn Bypass Pause

**File:** CreditLedger.sol:99, CreditLedger.sol:114

**Description:** `mint()` and `burn()` do not apply `whenNotPaused`. When CreditLedger is paused during an emergency, authorized callers (Audit, Escrow) can still mint and burn credits. This defeats the purpose of the emergency pause. The `pause()` and `unpause()` functions exist but are effectively dead code for core operations.

**Remediation:** Add `whenNotPaused` to both `mint()` and `burn()`. Note: this means Audit settlements will revert when CreditLedger is paused, which may require coordinated pause logic.

#### H-3: Buyer-Supplied Odds Create Quality Score Manipulation Surface

**Spec:** Whitepaper Section 5: Quality Score = favorable * (odds - 1) - unfavorable * SLA%.

**Code:** `Escrow.purchase()` (L310) accepts `odds` as a buyer parameter, bounded at 101-100000 (1.01x to 1000x). These odds directly feed into the quality score formula.

**Risk:** A Genius can create a sock-puppet Idiot, buy their own signals with 1000x odds on signals they know will be favorable, massively inflating their quality score and track record. Documented in DEV-012 but no code-level mitigation beyond the 1000x cap.

**Remediation:** Consider adding genius-set minOdds/maxOdds fields to the Signal struct so the genius controls the odds range. Alternatively, cap odds based on the signal's sport and market type.

#### H-4: Validator Vote Integrity (No Individual Outcome Verification)

**File:** OutcomeVoting.sol:370, Audit.sol:358

**Description:** In the voted settlement path, validators submit an aggregate `qualityScore` and `totalNotional` via `submitVote()`. Individual signal outcomes never reach the chain. The on-chain contracts have no way to verify the submitted score against actual purchase data. A colluding 2/3 validator majority can submit any score.

**Mitigation in place:** Validator economic incentives (staked TAO), 72h timelock for forceSettle recovery.

**Remediation:** Consider requiring the voted `totalNotional` to match the on-chain sum (verifiable from Escrow purchase records). This would prevent at least the notional component from being fabricated while keeping individual outcomes private.

---

### MEDIUM

#### M-1: forceSettle Allows Arbitrary Quality Scores

**File:** Audit.sol:431-475

**Description:** The owner (TimelockController) can settle any cycle with an arbitrary quality score. No guardrails exist (minimum stuck duration, score bounds relative to purchase data, etc.).

**Remediation:** Add `require(block.timestamp - firstVoteTimestamp > 7 days)` or similar to ensure forceSettle is only usable for genuinely stuck cycles.

#### M-2: Permissionless Signal Creation with Optional Collateral Gate

**File:** SignalCommitment.sol:210, 232-245

**Description:** Anyone can call `commit()`. The collateral gate only activates when `collateral != address(0)` and `maxNotional > 0`. Signals with `maxNotional = 0` (unlimited capacity) bypass the gate entirely. Enables griefing via signal spam.

**Remediation:** Require `collateral != address(0)` to be set before allowing commits. Apply collateral gate even for unlimited-notional signals using a minimum floor.

#### M-3: Stale Outcome Data After Voted Settlement

**File:** Escrow.sol:248

**Description:** After voted settlement, `Purchase.outcome` in Escrow remains `Pending` forever. `setOutcome()` could later be called to write outcomes to already-settled purchases. The Account-side reset prevents `recordOutcome` from succeeding, but Escrow-side writes still succeed, leaving inconsistent state.

**Remediation:** Add a guard in `setOutcome()` checking that the cycle has not been settled.

#### M-4: Missing totalNotional Validation in On-chain Settlement Path

**File:** Audit.sol:487-500

**Description:** `_aggregatePurchases()` sums `totalNotional` without checking against `MAX_CYCLE_NOTIONAL`. The voted path validates this. The on-chain path currently cannot exceed the bound (10 purchases * MAX_NOTIONAL per purchase = MAX_CYCLE_NOTIONAL), but if constants change independently, the invariant breaks.

**Remediation:** Add `require(totalNotional <= MAX_CYCLE_NOTIONAL)` in `_aggregatePurchases()`.

#### M-5: reduceFeePool Lacks nonReentrant

**File:** Escrow.sol:434

**Description:** `reduceFeePool()` is protected by `msg.sender == auditContract` but does not have `nonReentrant`. While Audit's entry points all have `nonReentrant`, making reentrancy through this path impossible in practice, the missing guard is a defense-in-depth gap.

**Remediation:** Add `nonReentrant` to `reduceFeePool()`.

#### M-6: Protocol Fee on Early Exit (Undocumented)

**File:** Audit.sol:312-345, 392-420

**Description:** Both `earlyExit()` and `earlyExitByVote()` charge the 0.5% protocol fee from genius collateral. The whitepaper says early exit settles in credits only, implying no USDC movement. The protocol fee is a USDC slash from collateral.

**Remediation:** Document this in DEVIATIONS.md or remove the protocol fee from early exits.

#### M-7: Storage Gap Documentation

**Files:** All 7 upgradeable contracts

**Description:** Storage gaps correctly sum to 50 total slots per contract, but there are no inline comments documenting the slot count formula. This makes future maintenance error-prone.

**Remediation:** Add comments: `// slots used: N | __gap: 50 - N = M` above each `__gap` declaration. Run `forge inspect ContractName storage` in CI.

#### M-8: SignalCommitment Uses Low-Level staticcall for Collateral Check

**File:** SignalCommitment.sol:236-244

**Description:** Uses raw `staticcall` with `abi.encodeWithSignature("getAvailable(address)")` instead of typed interface call. Silently returns 0 on failure, allowing signals without collateral backing.

**Remediation:** Import `ICollateral` and use a typed call. The interface already exists.

---

### LOW

#### L-1: Missing Zero-Address Checks on All setPauser() Functions (7 instances)
**Files:** Account.sol:356, Audit.sol:734, Collateral.sol:251, CreditLedger.sol:169, Escrow.sol:555, OutcomeVoting.sol:559, SignalCommitment.sol:391
**Fix:** Add `require(_pauser != address(0))`

#### L-2: Missing Events for OutcomeVoting.setAudit() and setAccount()
**File:** OutcomeVoting.sol:217-227
**Fix:** Emit `ContractAddressUpdated` events

#### L-3: KeyRecovery Not Upgradeable
**File:** KeyRecovery.sol:11
**Fix:** Consider UUPS pattern for consistency, or document intentional decision

#### L-4: renounceOwnership() Callable on All 7 Proxy Contracts
**Files:** All upgradeable contracts (inherited from OwnableUpgradeable)
**Fix:** Override `renounceOwnership()` to revert, preventing accidental permanent bricking

#### L-5: Signal Purchase Timing Edge Case
**File:** Escrow.sol:331
**Description:** `block.timestamp >= sig.expiresAt` allows purchase in the exact second of expiration
**Fix:** Document or change to strict `>` for "expired" semantics

#### L-6: Escrow.claimFees Ignores Partial Return Values
**File:** Escrow.sol:409, 454
**Description:** Slither flagged unused return values from `auditResults()`. Only `settledAt` is used.
**Fix:** Explicitly discard with named variables or comments

#### L-7: Account._resetCycle Gas Cost Unbounded by Constant
**File:** Account.sol:315-337
**Description:** Loop iterates over `acct.purchaseIds.length` (data-dependent), not `SIGNALS_PER_CYCLE` (10).
**Fix:** Add `assert(acct.purchaseIds.length <= SIGNALS_PER_CYCLE)` as defensive check

#### L-8: Collateral.withdrawalFreezeCount Has No Upper Bound
**File:** Collateral.sol:220
**Description:** Could theoretically overflow from buggy authorized caller, bricking withdrawals
**Fix:** Add `require(withdrawalFreezeCount[genius] < 1000)` sanity check

#### L-9: Fee Claim 48h Delay Creates Correction Window
**File:** Escrow.sol:405-425
**Description:** 48h `FEE_CLAIM_DELAY` after settlement before genius can claim fees. This is the only window to correct incorrect settlements via `forceSettle`. If the genius claims at 48h01m and a correction is needed, fees are already gone.
**Fix:** Consider extending to 72h to align with timelock delay, or add a fee claim freeze mechanism.

---

## 4. Spec Compliance Summary

| Spec Feature | Status | Notes |
|---|---|---|
| Signal creation (encrypted, 10 decoys, Shamir split) | Implemented off-chain | On-chain commit stores hash + metadata |
| Purchase flow (escrow deduction, fee = MP% * notional) | `full_match` | Correct implementation |
| Quality Score formula | `full_match` | +N*(odds-1) favorable, -N*SLA% unfavorable |
| Audit trigger at 10 signals/cycle | `full_match` | SIGNALS_PER_CYCLE = 10 |
| Tranche A (USDC, capped at fees paid) | `full_match` | Correct cap and routing |
| Tranche B (Credits, excess damages) | `full_match` | Non-transferable, non-cashable |
| Collateral = sum(notional * SLA%) | `code_stronger_than_spec` | Also pre-locks 0.5% protocol fee (DEV-023) |
| Protocol fee = 0.5% of notional | `full_match` | PROTOCOL_FEE_BPS = 50 |
| Credit system (non-transferable, USDC-first) | `full_match` | Correct refund ordering |
| Early exit (credits only) | `partial_match` | Protocol fee still charged in USDC |
| ZK proof settlement | `missing_in_code` | Replaced by validator voting (DEV-015) |
| Dispute resolution | `missing_in_code` | Not implemented, not documented |
| Withdrawal freeze during settlement | `full_match` | freezeWithdrawals/unfreezeWithdrawals |
| UUPS + TimelockController | `full_match` | 72h delay, all proxies verified |
| Per-signal odds | `mismatch` | Buyer-supplied, not genius-set (DEV-012) |
| Individual on-chain outcomes | `partial_match` | Only in non-voted path; voted path = aggregate only |
| Genius fee claim mechanism | `code_stronger_than_spec` | Added claimFees/claimFeesBatch (DEV-010) |

---

## 5. Trust Boundary Map

```
                    TimelockController (72h delay)
                              |
                    [onlyOwner on all 7 proxies]
                              |
        +-----+-----+--------+--------+-----+------+
        |     |     |        |        |     |      |
     Account Audit Collateral CreditLedger Escrow OV  SignalCommitment
        |     |     |        |        |     |
        +-----+-----+--------+--------+-----+
              |           |           |
        [authorized callers / contract-only]
              |           |           |
         Escrow <-> Audit <-> OutcomeVoting
              |           |
        [Genius/Idiot EOAs]  [Validators]
              |                  |
         deposit/purchase    submitVote
         withdraw/claim      proposeSync
         cancelSignal
```

**Key trust assumptions:**
- TimelockController is honest and operational (72h delay is the primary safeguard)
- 2/3+ validators are honest (for voted settlement)
- USDC token contract is standard ERC-20 (no fee-on-transfer, no rebasing)
- Block timestamps are accurate within ~15 seconds (Base chain)

---

## 6. Prioritized Remediation Plan

### Immediate (Before Mainnet)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | H-1: Switch to ReentrancyGuardUpgradeable | Low | Prevents chain compatibility and upgrade fragility risks |
| 2 | H-2: Add whenNotPaused to CreditLedger mint/burn | Low | Makes emergency pause actually work |
| 3 | L-4: Override renounceOwnership to revert | Low | Prevents irreversible bricking |
| 4 | C-2: Document dispute resolution status in DEVIATIONS.md | Low | Transparency |
| 5 | M-5: Add nonReentrant to reduceFeePool | Low | Defense-in-depth |
| 6 | L-1: Add zero-address checks to all setPauser functions | Low | Defense-in-depth |

### Short-Term (Before Public Launch)

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 7 | C-1: Update whitepaper to reflect validator voting model | Medium | Accurate trust model documentation |
| 8 | H-3: Add genius-controlled odds range to Signal struct | Medium | Prevents Sybil score inflation |
| 9 | H-4: Verify totalNotional matches on-chain data in voted path | Medium | Partial vote integrity |
| 10 | M-1: Add time guard to forceSettle | Low | Limits centralization risk |
| 11 | M-2: Require collateral contract set + minimum for signal creation | Low | Prevents griefing |
| 12 | M-8: Replace staticcall with typed interface call | Low | Type safety |

### Medium-Term

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 13 | M-3: Guard setOutcome against settled cycles | Low | State consistency |
| 14 | M-4: Add totalNotional bound in _aggregatePurchases | Low | Invariant safety |
| 15 | M-6: Document protocol fee on early exit | Low | Transparency |
| 16 | M-7: Add storage gap documentation and CI check | Low | Upgrade safety |
| 17 | Add Foundry invariant tests (handler-based stateful fuzzing) | High | Confidence in state invariants |

---

## 7. Risk Assessment

### Architecture Strengths
- **Consistent security patterns**: CEI, ReentrancyGuard, Pausable, UUPS with whenPaused upgrade gate
- **TimelockController ownership**: All admin operations require 72h delay
- **Bounded loops**: All iterations capped at 10 (SIGNALS_PER_CYCLE) or 100 (batch operations)
- **Comprehensive test suite**: 371 tests including fuzz testing
- **Clean dependency**: OpenZeppelin v5.5.0, no exotic libraries
- **Storage gaps**: Correctly sized to 50 slots per contract

### Architecture Risks
- **Validator trust model**: 2/3+ colluding validators can fabricate settlement outcomes
- **Single-point admin**: TimelockController controls all contracts; compromise = total system compromise
- **Buyer-supplied odds**: Quality score manipulation via self-dealing possible
- **Dual settlement paths**: On-chain and voted paths have different data flows, creating potential for inconsistency
- **Permissionless settlement timing**: Anyone can trigger settlement; parties cannot control timing

### Conclusion

The Djinn Protocol contracts demonstrate security maturity above average for DeFi projects at this stage. The core financial math is correct, access control is consistently applied, and the test suite is comprehensive. The two CRITICAL findings are spec compliance gaps (not code vulnerabilities) that should be addressed through documentation updates and eventual implementation. The HIGH findings are actionable and relatively low-effort to fix. No fund-draining vulnerabilities were identified under the assumed trust model (honest TimelockController, 2/3+ honest validators).
