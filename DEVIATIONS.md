# Deviations from Whitepaper

Append-only log. Each entry documents where implementation diverges from `docs/whitepaper.md`.
See the whitepaper for design intent.

---

## DEV-001: Miner Scoring Weights

**Whitepaper Section:** Validators and Miners > Scoring
**Whitepaper Says:** 5 metrics — Speed 40%, Accuracy 20%, Uptime 10%, History 10%, TLSNotary 20%
**PDF v9 Says:** 4 metrics — Accuracy 40%, Speed 25%, Coverage 20%, Uptime 15%
**We Follow:** PDF v9 (4 metrics). The PDF is the most recent version of the whitepaper.
**Why:** The KICKOFF.md references a 5-metric system from an older version. PDF v9 consolidates to 4 metrics which is simpler and weights accuracy highest, which is correct.
**Impact:** Miner incentive economics. Non-breaking — just different weights.

## DEV-002: Bittensor Template Not Used

**Whitepaper Section:** N/A (implementation detail)
**What happened:** The opentensor subnet template (`djinn_subnet/`, `neurons/`) in the repo has known memory leaks (reported by Loai, confirmed by Tom Matcham). The Bittensor API is Rust with a thin Python wrapper that doesn't clean up properly.
**What we did:** Writing custom validator/miner code from scratch instead of extending the template. Will reference Loai's memory leak fix PR.
**Impact:** Better stability, no memory leaks in production validators/miners.

## DEV-003: MPC Protocol Simplified for Prototype

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Whitepaper Says:** 2-round MPC with additive secret sharing, no validator learns the actual index
**What we did:** Prototype uses Lagrange reconstruction + polynomial evaluation. The aggregator reconstructs the secret from Shamir shares and evaluates the availability polynomial P(secret). This reveals the secret to the aggregator.
**Production TODO:** Replace with SPDZ-style MPC or garbled circuit evaluation to prevent the aggregator from learning the secret. The protocol interface (compute_local_contribution → check_availability) is designed to be swappable.
**Impact:** Security — in production, the aggregator validator would learn which line is real. Functionally correct (single-bit output is correct). Privacy guarantee weakened until production MPC is implemented.

## DEV-004: Groth16 Instead of PLONK [SUPERSEDED]

**Status:** Superseded by DEV-015. ZK circuits and on-chain verifiers removed (2026-03-25). Track records are computed from public on-chain audit settlements. No ZK proofs needed.

## DEV-005: TrackRecord Circuit MAX_SIGNALS Reduced 64 → 20 [SUPERSEDED]

**Status:** Superseded by DEV-015. TrackRecord.sol, ZKVerifier.sol, and Groth16 verifiers removed (2026-03-25). Track records are computed from public on-chain audit settlements.

## DEV-006: Secure MPC Implemented with Beaver Triples [UPDATES DEV-003]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Whitepaper Says:** 2-round MPC, no validator learns the actual index
**What we did:** Implemented `SecureMPCSession` using Beaver triple-based multiplication. The protocol computes r * P(s) where P(x) = ∏(x - a_i) for available indices and r is joint randomness. The result is 0 iff the secret is in the available set. No single party reconstructs the secret — only blinded differences (d = x - a, e = y - b) are opened, where a and b are random Beaver triple values.
**Protocol details:** Sequential multiplication through Beaver triples. For d available indices, requires d multiplications (each 1 communication round). Uses trusted dealer model for triple generation (production would use OT-based offline phase).
**Communication rounds:** Tree multiplication (implemented in `SecureMPCSession.compute()`) reduces rounds from d+1 to ceil(log2(d))+2 ≈ 6 for d=10. The distributed MPC orchestrator uses sequential gates (d rounds) because each gate requires a network round-trip.
**Remaining work:** ~~Trusted dealer model for triple generation should be replaced with OT-based offline phase in production.~~ **Resolved in DEV-008.** ~~Tree multiplication could reduce rounds.~~ **Implemented for local MPC; distributed path remains sequential.**
**Impact:** Security significantly improved — no single aggregator learns the secret index. The core MPC math is production-ready.

## DEV-007: MPC Distributed Networking Implemented [UPDATES DEV-006]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Whitepaper Says:** Validators exchange messages to jointly compute availability without revealing the secret
**What we did:** Implemented the full distributed MPC networking layer:
- Coordinator generates random mask r, splits into Shamir shares, distributes with Beaver triple shares via `POST /v1/mpc/init`
- For each multiplication gate: coordinator collects (d_i, e_i) from peers via `POST /v1/mpc/compute_gate`, reconstructs opened values d, e, feeds into next gate
- After final gate, coordinator computes output shares and reconstructs r * P(s); broadcasts result via `POST /v1/mpc/result`
- Circuit breaker: peers that fail mid-protocol are removed from the active set; protocol continues if remaining participants >= threshold
- Parallel peer requests using `asyncio.gather` for each gate
**Trusted dealer limitation:** ~~Coordinator generates and distributes Beaver triple shares, so it knows all (a, b, c) values.~~ **Resolved in DEV-008.**
**Impact:** Multi-validator MPC now works end-to-end over HTTP. Single-validator prototype mode is preserved as fallback when no peers are available.

## DEV-008: OT-Based Beaver Triple Generation [RESOLVES DEV-006/DEV-007 LIMITATION]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Previous limitation:** DEV-006/DEV-007 used a trusted dealer model for Beaver triple generation. The coordinator knew all (a, b, c) values in the clear, meaning it could theoretically derive peers' secret shares.
**What we did:** Implemented OT-based distributed triple generation (`validator/djinn_validator/core/ot.py`):
- **Gilboa multiplication** (bit-decomposition + correlated OT): Each pair of parties (i, j) jointly computes additive shares of a_i * b_j without either party learning the other's input. Uses 256 rounds of 1-of-2 OT per multiplication (one per bit of the field element).
- **Distributed triple generation**: Each party generates random additive shares of a and b. Cross-terms (a_i * b_j for i != j) are computed via Gilboa multiplication. No single party learns the full triple.
- **Additive-to-Shamir conversion**: Additive shares are converted to Shamir shares via each party independently Shamir-sharing their additive share and parties summing the received evaluations.
- The coordinator now uses OT-based triples when >= 2 participants are available, falling back to trusted dealer only in single-validator dev mode.
**Security model:** Semi-honest (honest-but-curious). For malicious security, add MAC-based verification (SPDZ-style) in a future iteration.
**Performance:** Gilboa multiplication involves 256 OT instances per field multiplication, which is compute-intensive but parallelizable. For 10 available indices with 10 parties, this is 10 triples * 45 pairs * 256 OTs = ~115K OT instances. In practice, the OT operations are local hash evaluations (~3s on consumer hardware). Network round-trips for actual OT message exchange are not yet implemented — the current protocol simulates OT locally and would need `/v1/mpc/ot/*` endpoints for full distributed deployment.
**Impact:** Eliminates the trusted dealer limitation. The coordinator no longer learns Beaver triple underlying values. 47 new tests verify correctness, randomness, and compatibility with existing MPC protocol.

## DEV-009: Network OT Endpoints for Distributed Triple Generation [EXTENDS DEV-008]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Previous limitation:** DEV-008 computed OT-based triples locally within a single process. For actual multi-validator deployment, OT messages must traverse the network.
**What we did:** Implemented the full network-aware OT protocol in `validator/djinn_validator/core/ot_network.py`:
- **DH-based Gilboa OT**: Sender generates DH keypair (a, A=g^a). Receiver encodes bit b via T_k = g^{r_k} (b=0) or A·g^{r_k} (b=1). Sender derives two keys K0=H(T_k^a), K1=H((T_k/A)^a) and XOR-encrypts both messages. Only the receiver can decrypt the chosen one.
- **Configurable DH groups**: `DHGroup` abstraction supports RFC 3526 Group 14 (2048-bit) for production and a small safe prime (p=1223) for fast tests.
- **Adaptive bit count**: OT round count per multiplication matches field prime bit length (17 bits for test, 254 for BN254), minimizing unnecessary work.
- **OTTripleGenState**: Full lifecycle state machine managing sender/receiver setup, choice generation, transfer encryption/decryption, share accumulation, and Shamir polynomial evaluation.
- **REST endpoints**: `POST /v1/mpc/ot/{setup,choices,transfers,complete}`, `POST /v1/mpc/ot/shares`, `GET /v1/signal/{id}/share_info` — 6 new endpoints for the 4-phase OT protocol (setup → choices → transfers → complete) plus share retrieval and peer discovery.
- **Body size limit**: OT endpoints accept up to 5MB (DH group elements are large).
- **Serialization helpers**: Hex-encoded DH public keys, choice commitments, and encrypted transfers for HTTP transport.
**Security model:** CDH assumption in the chosen DH group. Semi-honest — same as DEV-008. SPDZ MAC verification deferred to future work.
**Impact:** Validators can now exchange Beaver triple shares over HTTP without any party learning the other's inputs. 35 new tests verify OT correctness, triple generation, Shamir conversion, serialization roundtrips, and all API endpoints. Full test suite (693 tests) passes with no regressions.

## DEV-010: SPDZ MAC Verification for Malicious Security [EXTENDS DEV-008/DEV-009]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Previous limitation:** DEV-008/DEV-009 assumed a semi-honest (honest-but-curious) adversary model. A malicious party could corrupt their shares to manipulate the MPC output without detection.
**What we did:** Implemented SPDZ-style information-theoretic MAC verification in `validator/djinn_validator/core/spdz.py`:
- **Global MAC key α**: Shamir-shared among validators. No single party knows α.
- **Authenticated shares**: Every shared value v carries MAC shares γ(v) where reconstruct(γ) = α * v. MACs are independently Shamir-shared.
- **Authenticated Beaver triples**: Triple components (a, b, c) all carry MAC shares.
- **MAC verification on every opening**: When d = x - a is opened, each party computes σ_j = γ(d)_j - α_j * d. Reconstructing Σ L_j * σ_j = 0 proves correctness; non-zero means cheating.
- **Commit-then-reveal protocol**: Parties commit to σ_j before revealing, preventing adaptive forgery.
- **AuthenticatedMPCSession**: Full MPC protocol with MAC checks on every multiplication gate opening. Aborts with `MACVerificationError` if any check fails.
- **AuthenticatedParticipantState**: Per-validator state for distributed protocol with MAC support.
- **MAC propagation through multiplication**: z = d*e + d*b + e*a + c has MAC γ(z)_j = d*e*α_j + d*γ(b)_j + e*γ(a)_j + γ(c)_j.
**Security model:** Active security with abort (malicious parties detected, protocol aborts). With 7-of-10 honest majority, guaranteed output delivery.
**Impact:** 32 new tests verify MAC generation, verification, commitment protocol, authenticated MPC correctness (including randomized trials), and tamper detection for corrupted shares and triples. 725 total tests pass.

## DEV-011: SPDZ Gossip-Abort and Payment Verification [EXTENDS DEV-010]

**Whitepaper Section:** Appendix A — Purchase Flow, Appendix C — MPC Protocol
**Previous limitations:**
1. MAC verification failure caused silent local abort — other validators continued computing with corrupted shares.
2. Purchase endpoint released key shares without verifying on-chain USDC payment.
**What we did:**
- **Gossip-abort protocol**: When the coordinator detects MAC verification failure during an authenticated MPC session, it broadcasts `POST /v1/mpc/abort` to all participants. Peers mark the session as FAILED and clean up state. The `compute_gate` endpoint rejects requests (HTTP 409) for aborted sessions.
- **On-chain payment verification**: The purchase endpoint now queries the Escrow contract via `chain_client.verify_purchase()` before releasing key shares. Returns `"payment_required"` status when `pricePaid == 0`. In dev mode (no chain client), skips the check with a warning for backwards compatibility. Uses `keccak256(signal_id)` for string-to-uint256 mapping.
**Impact:** Gossip-abort ensures consistency — all honest validators abort together when cheating is detected. Payment verification prevents free signal access. 6 new tests cover abort/payment flows. 736 total validator tests pass.

## DEV-012: Network OT Wired into MPC Orchestrator [EXTENDS DEV-009]

**Whitepaper Section:** Appendix C — MPC Set-Membership Protocol
**Previous limitation:** DEV-009 implemented the OT network endpoints and state machine, but the MPC orchestrator still generated triples locally — the coordinator knew all triple values during generation.
**What we did:** Wired the 4-phase OT protocol into the MPC orchestrator (`mpc_orchestrator.py`):
- **`_generate_ot_triples_via_network()`**: Drives the full bidirectional Gilboa OT protocol over HTTP with a peer validator. Both cross-terms (coordinator.a × peer.b and peer.a × coordinator.b) are computed via OT so neither party learns the other's random values.
- **Protocol flow**: Setup → exchange sender PKs → bidirectional choice generation → bidirectional transfer processing → decrypt & accumulate → compute Shamir evaluations → collect partial shares and combine into BeaverTriple objects.
- **Activation**: Enabled via `USE_NETWORK_OT=1` env var. Currently supports the 2-party case (coordinator + 1 peer). Falls back to local triple generation when OT fails or when >1 peer is available.
- **Configurable parameters**: DH group and field prime can be specified via the OT setup request, allowing fast DH groups (p=1223) in tests while using RFC 3526 Group 14 (2048-bit) in production.
- **Graceful fallback**: If any OT phase fails (network error, serialization issue), falls back to local OT triple generation with a warning log.
- **Serialization fix**: `deserialize_dh_public_key` and `deserialize_choices` now handle both `0x`-prefixed and raw hex formats. Server uses `serialize_dh_public_key()` for consistent fixed-width encoding.
**Limitation:** 2-party only — for n > 2 validators, peer-to-peer OT connections would be needed (each pair must independently run the OT protocol). The star topology (coordinator hub) still means the coordinator collects all Shamir evaluations; a fully peer-to-peer topology is deferred.
**Impact:** 7 new integration tests verify available/unavailable/single-index/all-indices/fallback/3-validator scenarios. 743 total validator tests pass.

## DEV-013: Tranche A Slash Direct to Idiot Wallet [CHANGES SETTLEMENT FLOW]

**Whitepaper Section:** Section 7 — Audit Settlement
**Whitepaper Says:** "Collateral → Escrow (Tranche A)" — genius collateral is slashed to escrow, then idiot gets a refund.
**What we did:** Changed `Audit._distributeDamages()` to slash collateral directly to the idiot's wallet (`collateral.slash(genius, trancheA, idiot)`) instead of routing through escrow.
**Why:** The original flow created stranded USDC: collateral was slashed to the escrow contract address, but escrow's internal accounting (feePool/balances) didn't track the incoming tokens. The `_refundFromFeePool` call moved existing fee pool accounting (fees the idiot already paid) rather than accounting for the newly-slashed collateral. This left the slashed USDC permanently unwithdrawable in the escrow contract.
**Alternative considered:** Adding a `creditBalance(address, uint256)` function to Escrow callable by Audit would have preserved the "Collateral → Escrow" path. Chose direct-to-wallet for simplicity and better UX (idiot receives USDC immediately without needing to withdraw from escrow).
**Impact:** Economic outcome identical — idiot receives the same USDC amount. UX improved — no additional withdrawal step. Fee pool for the cycle is left intact (genius earned fees stay in escrow; a future genius fee claim mechanism may be needed).

## DEV-014: Batch Recovery Blob Instead of Per-Signal Key Wrapping

**Whitepaper Section:** Section 5 (Creation/Purchase), Section 9 (Wallet-Based Key Recovery), Appendix B (KeyRecovery contract)
**Whitepaper Says:** "Re-encrypts the signal key to the user's wallet public key" — per-signal, stored via `KeyRecovery.storeEncryptedKey(signal_id, encrypted_key, wallet)`. Both genius and idiot store per-signal encrypted keys.
**What we did:** Implemented a batch approach: all genius signal data (preimages, real indices) is JSON-serialized, encrypted with an AES-256-GCM key derived from SHA-256 of a wallet signature ("Djinn Key Recovery v1"), and stored as a single blob via `KeyRecovery.storeRecoveryBlob(bytes)`. Maximum 4KB.
**Why:**
1. No ECIES library in the codebase — would need a new dependency for wallet-pubkey encryption
2. AES-256-GCM is already implemented and battle-tested in the crypto module
3. RFC 6979 deterministic ECDSA means `personal_sign` of a fixed message always produces the same signature → same derived key → deterministic recovery without storing any secret
4. Single blob is simpler than N per-signal entries on-chain (fewer txs, less gas)
**Tradeoff:** Requires a wallet signature popup on recovery. The whitepaper's per-signal approach would be transparent (just read + decrypt with wallet key). But signature-derived approach needs zero new crypto primitives.
**Impact:** Same user-facing outcome — genius can recover signal data from any device via wallet. Implementation mechanism differs from whitepaper.

## DEV-015: Idiot-Side Recovery Not Yet Implemented [TODO]

**Whitepaper Section:** Section 5 (Purchase step 6), Section 9 (Wallet-Based Key Recovery)
**Whitepaper Says:** "Bob's browser re-encrypts the signal key to Bob's wallet public key and posts it on-chain for recovery from any device."
**What we did:** Only genius-side recovery is implemented. After purchase, the idiot's reconstructed AES key is used to decrypt but is not persisted for recovery.
**Why:** Focused on genius recovery first (higher stakes -- genius needs preimages to reconstruct signal details). Idiot recovery is lower priority since the decrypted pick is ephemeral information.
**Impact:** If an idiot clears browser cache, they cannot re-decrypt a previously purchased signal from another device. The purchase itself is recorded on-chain, so settlement/audit is unaffected.

## DEV-016: Index Shares Not Distributed for MPC [RESOLVED]

**Whitepaper Section:** Section 5 (Creation), Appendix C
**Whitepaper Says:** "Splits the real signal's index into 10 pieces via a separate Shamir sharing (for the MPC executability check)" — this happens at signal creation in the browser.
**What we did:** The web client already Shamir-splits the realIndex and sends `encrypted_index_share` alongside `encrypted_key_share`. The validator API (`StoreShareRequest`), share store (SQLite schema v4), and server endpoint now accept and persist index shares for MPC use.
**Resolution:** Web client was already correct. Added `encrypted_index_share` field to validator API model, database schema (migration v4), and store/retrieve logic. Full MPC executability check pipeline is now wired end-to-end.

## DEV-017: Per-Sport Track Records — Client-Side Filter [PARTIAL]

**Whitepaper Section:** Section 5 (Discovery), Section 6 (Track Record Metrics)
**Whitepaper Says:** "Track records are displayed per sport... Sport-level track records receive individual ZK proofs."
**What we did:** Added a sport filter dropdown on the track record proof generation page so geniuses can generate proofs for a single sport. The ZK circuit itself remains sport-agnostic — it proves aggregate stats over whatever signals are selected. Separate proofs per sport are possible by filtering and running the circuit multiple times.
**Why:** Full per-sport ZK circuit outputs would require redesigning the circuit's public outputs. Client-side filtering achieves the same result more simply.
**Impact:** Geniuses can now generate sport-specific proofs. The leaderboard still shows aggregate stats (not per-sport breakdown).

## DEV-018: Per-Outcome Metrics Added to Subgraph + Leaderboard [RESOLVED]

**Whitepaper Section:** Section 5 (Discovery)
**Whitepaper Says:** Buyers should see: "favorable rate, unfavorable rate, void rate"
**What we did:** Added `totalFavorable`, `totalUnfavorable`, `totalVoid` fields to the Genius subgraph entity. Added a Win Rate column to the leaderboard showing W/L/V counts. The idiot signal browse also shows genius ROI. Subgraph mappings increment per-outcome counters on OutcomeUpdated events.
**Remaining:** Purchase success rate and proof coverage % are not yet shown (would need additional subgraph queries).
**Impact:** Buyers can now see win rate and outcome breakdown for each genius in the leaderboard.

---

## 14. Multi-Purchase Signals [DEVIATION:REVIEW]

**Date:** 2026-02-20
**Whitepaper Section:** Section 3 (Purchase Flow)
**Whitepaper Says:** A signal transitions to `Purchased` status after the first purchase, blocking further purchases.
**What we did:** Signals now support multiple buyers. The `Purchased` status is no longer set by Escrow — signals stay `Active` while purchases accumulate against a cumulative `signalNotionalFilled` mapping. Added `minNotional` field to Signal struct to prevent dust griefing. Genius can void a signal even after partial fills.
**Why:** A genius publishing a $10,000 signal could only sell to one buyer, severely limiting market liquidity and fee revenue. Multi-purchase lets multiple idiots each buy a portion until capacity is filled.
**Contracts changed:** IDjinn.sol (struct), SignalCommitment.sol (storage + state transitions), Escrow.sol (cumulative tracking, minNotional check)
**No changes needed:** Collateral.sol (already uses `+=`), Audit.sol (works on individual purchases)
**Impact:** Economic (more fee revenue per signal), user-facing (fill progress UI, minNotional setting).

## DEV-019: Web Attestation Service — Pure Bittensor, No Base Contract

**Date:** 2026-02-20
**Whitepaper Section:** Section 15 — Web Attestation Service
**Whitepaper Says:** "A user submits a URL and fee to the Web Attestation contract on Base." — USDC fee on Base, on-chain proof hash storage, single additional smart contract.
**What we did:** Implemented the Web Attestation Service as a pure Bittensor-native service with no Base chain involvement. Users submit URLs for free via the web app. Validators dispatch to miners. Miners generate TLSNotary proofs. Miners earn emission credit for attestation work through the existing scoring pipeline (accuracy, speed, coverage, uptime). No smart contract, no USDC fee, no on-chain proof storage.
**Why:** Keeps the attestation service simple and permissionless. Emissions already incentivize miners — adding a separate USDC fee contract introduces unnecessary complexity for an MVP. The alpha token gains value from the subnet doing useful work. Paid tiers can be added later via an optional Base contract if demand warrants.
**Impact:** Users get free attestation (emission-funded vs fee-funded). No additional smart contract deployment needed. Proofs are returned directly to users as downloadable files rather than stored on-chain. Arweave storage deferred to future iteration.

## DEV-020: Alpha Burn Gate for Web Attestation [EXTENDS DEV-019]

**Date:** 2026-02-20
**Whitepaper Section:** Section 15 — Web Attestation Service
**Whitepaper Says:** "A user submits a URL and fee to the Web Attestation contract on Base." — USDC fee on Base chain via a smart contract.
**What we did:** Added an alpha burn gate to the attestation service. Users burn 0.0001 TAO (~$0.02) of SN103 alpha to a well-known unrecoverable SS58 address before each attestation. The validator verifies the burn on-chain via substrate RPC and tracks consumed extrinsic hashes in a SQLite ledger to prevent double-spend. No Base chain involvement.
**Why:** Each attestation costs real miner compute (30-90s CPU for TLSNotary MPC). Without a fee, nothing deters spam and no revenue flows to the subnet. Alpha burn is pure Bittensor — no smart contract, no bridge, no USDC. Permanently removes alpha from circulation, benefiting all SN103 stakers.
**Architecture:** User burns alpha → provides extrinsic hash → validator queries substrate to verify transfer destination and amount → checks SQLite ledger for double-spend → dispatches to miner if valid.
**Future:** Add USDC and TAO payment options alongside alpha. MVP = alpha burn only.
**Impact:** Attestation is no longer free but essentially free for legitimate users (~$0.02). At volume (1,000/day = $20/day burned permanently). Spam is deterred. Burn address: `5E9tjcvFc9F9xPzGeCDoSkHoWKWmUvq4T4saydcSGL5ZbxKV` (Djinn-specific wallet, seed discarded — prevents cross-subnet burn reuse). Supports multi-credit bulk burns: burn N * 0.0001 TAO for N attestation credits. Sender coldkey tracked per burn.

---

## DEV-010: Genius Fee Claim Mechanism

**Date:** 2026-02-21
**Whitepaper Section:** Section 7 — Settlement / Fee Pool
**Whitepaper Says:** "Genius keeps all fees" when Quality Score >= 0 after audit. No explicit withdrawal mechanism specified.
**What we did:** Added `claimFees(idiot, cycle)` and `claimFeesBatch(idiots[], cycles[])` to the Escrow contract. After an audit cycle settles, the Genius calls `claimFees` to withdraw their earned USDC from the fee pool. The function verifies settlement via `IAuditForEscrow.auditResults()` and transfers the remaining fee pool balance to the Genius wallet.
**Why:** Without an explicit claim function, fees accumulated in the fee pool with no withdrawal path. The whitepaper describes fees being "kept" but never specifies how the Genius receives them. Pull-based claiming (vs automatic push during settlement) keeps settlement gas costs predictable and gives Geniuses control over timing.
**Impact:** Geniuses can now withdraw earned fees. Batch claiming reduces gas for prolific Geniuses with many Idiot pairs. Double-claim is prevented by zeroing the fee pool entry.

## DEV-011: Track Record Proofs Prove Claimed Outcomes, Not Validator Consensus

**Date:** 2026-02-22
**Whitepaper Section:** Section 8 — ZK Track Record / Portable Credentials
**Whitepaper Says:** Geniuses generate ZK proofs of their track record that are cryptographically verifiable.
**What we did:** The ZK track record circuit proves outcomes as claimed by the Genius (via their signal preimages and stated outcomes). It does NOT prove that these outcomes match what validators voted on via OutcomeVoting. With the aggregate voting architecture (DEV-043), individual per-purchase outcomes never go on-chain, so the circuit cannot verify them against on-chain state.
**Why:** Storing per-purchase validator votes on-chain would leak which lines are real (defeating the privacy goal of aggregate voting). The track record proof serves a different purpose: portable credibility for leaderboards and discovery, not automated dispute resolution.
**Impact:** Track record proofs are safe for reputation/leaderboard use. They are NOT suitable for automated dispute resolution without additional on-chain vote storage. This is acceptable for the current phase. Future iterations could use proof composition with off-chain validator attestations.
**Security Model:** A malicious Genius could claim different outcomes than validators voted. However, the economic incentive to lie is low: the leaderboard affects discovery priority but not settlement amounts (which are determined by OutcomeVoting consensus).

## DEV-012: Buyer-Supplied Odds and Sybil Resistance

**Date:** 2026-02-22
**Whitepaper Section:** Section 5 — Quality Score formula
**Whitepaper Says:** Quality Score = Σ(favorable gains) - Σ(unfavorable losses). Gain uses odds; loss uses SLA multiplier.
**What we did:** Odds are buyer-supplied at purchase time (validated at 1.01x–1000x). The asymmetry between gain (proportional to odds) and loss (proportional to slaMultiplierBps) is intentional per the whitepaper — favorable longshots should reward the Genius more.
**Known risk:** A Genius could create a sock-puppet Idiot, buy their own signals with very high odds on signals they know will be favorable, inflating their quality score and track record. This is a Sybil attack, not a code vulnerability.
**Mitigations in place:** Rate limiting, one purchase per Idiot per signal (`hasPurchased` mapping), odds bounded at 1000x max.
**Future mitigations:** Per-signal odds range set by Genius (add minOdds/maxOdds to Signal struct), stake-based Sybil resistance, identity verification for leaderboard prominence.
**Impact:** Track record inflation via self-dealing is possible but limited (attacker pays fees and collateral). Settlement economics are unaffected — damages are per Genius-Idiot pair. No code change needed at this stage.

## DEV-013: Split Attestation vs Sports Scoring [UPDATES DEV-001]

**Date:** 2026-02-22
**Whitepaper Section:** Validators and Miners > Scoring
**Previous behavior:** `record_attestation()` fed into the same `queries_total/queries_correct/latencies/proofs_submitted` counters as sports challenges. This conflated two fundamentally different workloads — sports executability checks (~5s, optional TLSNotary) vs web attestation (~30-90s, mandatory TLSNotary, $0.02 burn cost).
**What we did:** Split `MinerMetrics` into separate sports and attestation tracking. Attestation has its own counters (`attestations_total`, `attestations_valid`, `attestation_latencies`) and its own scoring axes (60% proof validity, 40% speed). Final score blends sports (80%) and attestation (20%) via `W_ATTESTATION_BLEND`. Latencies are normalized independently per challenge type.
**Why:** Attestation miners burn ~$0.02 per challenge. They need proportional emission share to break even. Conflating 30-90s attestation latencies with <10s sports latencies unfairly penalized attestation speed scores. Separate scoring lets each workload be evaluated on its own terms.
**Impact:** Miners doing attestation work get fairly scored. The 20% blend weight ensures attestation contributes meaningfully to emission share without dominating sports scoring. Configurable via `attestation_blend` constructor parameter.

## DEV-014: Remove Odds API Dependency from Validator [UPDATES DEV-013]

**Date:** 2026-02-22
**Whitepaper Section:** Validators and Miners > Scoring, Section 7 — Outcome Resolution
**Previous behavior:** Validators required a paid Odds API key (`SPORTS_API_KEY`) for two purposes: (1) fetching ground-truth odds to compare against miner responses in challenges, and (2) fetching game scores for outcome resolution. This conflated the validator's role (verify miners, settle outcomes) with the miner's role (check line availability at sportsbooks).
**What we did:**
1. **Outcome resolution:** Replaced The Odds API scores endpoint with ESPN's free public scoreboard API (`site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`). Games are matched by team names + date using a static normalization table of ~120 teams. ESPN client has its own circuit breaker.
2. **Miner challenges:** Replaced odds-based ground truth with proof-based verification. Validators build challenges from ESPN live games (just need game existence, not odds), send to miners, and verify via TLSNotary proofs. Miners now return a `query_id` in CheckResponse that the validator uses to request a TLSNotary proof of the check. Old miners without `query_id` are scored on claims only.
3. **Config:** `SPORTS_API_KEY` is deprecated. The field remains for backwards compatibility but generates a warning if set. Production validators no longer require it.
**Why:** Validators shouldn't need a paid API key to do their job. Miners are the ones checking line availability — their claims should be verified cryptographically (TLSNotary), not by independently querying the same data source. ESPN's scoreboard is free, has no rate limits, and provides all the score data needed for outcome resolution.
**Impact:** Validators no longer need an Odds API subscription. Challenge accuracy scoring now depends on TLSNotary proofs rather than API-based ground truth. Outcome resolution uses ESPN instead of Odds API. Backwards compatible — old miners without `query_id` support still get scored.

## DEV-015: ZK Track Record Proofs Unnecessary — On-Chain Aggregates Are Public [UPDATES DEV-011]

**Date:** 2026-02-23
**Whitepaper Section:** Section 8 — ZK Track Record / Portable Credentials
**Whitepaper Says:** Geniuses generate ZK proofs of their track record that are cryptographically verifiable and portable.
**What we did:** With audit-set-level settlement (DEV-043 evolution), validators vote aggregate statistics (quality_score, wins, losses, voids, n) per (genius, idiot, cycle) on-chain via OutcomeVoting. After 2/3+ consensus, Audit.sol finalizes settlement. The genius's track record is a simple sum over all finalized audit set records — publicly readable from the chain. A ZK proof would prove something anyone can already verify by querying on-chain events.
**Why:** ZK proofs are useful when you need to prove a statement without revealing the underlying data. But the aggregate audit results are already public on-chain. There is no private data to hide — the track record IS the public settlement history.
**Impact:** The ZK track record circuit (circom) and proof generation flow can be removed. Track records are computed by summing finalized Audit.sol records. Leaderboards read directly from on-chain data. Portable credentials can be implemented as signed attestations referencing on-chain state rather than ZK proofs.

## DEV-021: Peer-to-Peer Notarization — Miners as Notaries [EXTENDS DEV-019]

**Date:** 2026-03-05
**Whitepaper Section:** Section 15 — Web Attestation Service, TLSNotary Infrastructure
**Whitepaper Says:** "Miners fetch the URL and generate a TLSNotary proof" — implies a single, external notary server for the MPC co-signing role.
**What we did:** Implemented peer-to-peer notarization where miners serve as notaries for each other, eliminating the dependency on a centralized notary server (notary.pse.dev or self-hosted). Architecture:
- **Miner notary sidecar:** Miners optionally run `djinn-tlsn-notary` as a background process (opt-in via `NOTARY_ENABLED=true`). The sidecar listens on TCP for MPC sessions and signs attestations with its secp256k1 key.
- **Notary discovery:** Validators probe `/v1/notary/info` on all miners to discover notary-capable peers. Old miners without the endpoint return 404 and are silently skipped.
- **Random pairing:** Validators randomly assign a peer notary for each attestation challenge. The prover miner receives `notary_host`/`notary_port` in the challenge payload and connects to the assigned peer instead of the default notary. Old miners that don't understand these fields ignore them and use their configured default.
- **Verification:** Validators pass the assigned notary's pubkey as `expected_notary_key` during proof verification, in addition to the statically configured `TLSN_TRUSTED_NOTARY_KEYS`. Both centralized and peer-signed proofs are accepted during the transition period.
- **Scoring:** Miners who reliably serve as notaries receive a 10% bonus on their uptime score component. Notary duty counts as participation for epoch continuity.
**Trust model:** The notary can't see plaintext data (MPC guarantees). A dishonest notary can refuse to cooperate (DoS → penalized) but can't forge data. Random, unpredictable pairing by the validator prevents pre-arranged collusion. The trust assumption is "the randomly paired miner is not colluding with the prover."
**Backwards compatibility:** All changes are additive and optional. Old miners work with new validators (no notary fields = use default). New miners work with old validators (notary sidecar just sits idle). Transition: as miners and validators update, peer notarization gradually replaces centralized notary dependency.
**Impact:** Eliminates the only centralized dependency in the entire protocol — the TLSNotary notary server. PSE's `notary.pse.dev` (which explicitly says "do not build your business on it") is no longer a single point of failure. The notary server code was removed from the TLSNotary repo in alpha.13, making self-hosting a maintenance burden; peer notarization sidesteps this entirely.

---

## DEV-013: Dynamic Shamir Threshold

**Whitepaper Section:** Signal Lifecycle, Shamir Secret Sharing
**Whitepaper Says:** Implies a fixed threshold (7 of 10) for Shamir secret sharing.
**What we did:** Made the threshold dynamic based on active validator count: `clamp(ceil(2/3 * healthy_validators), SHAMIR_MIN, 7)`. Cap of 7 (don't require too many even at scale). Both client and validator use the same formula.
**Bootstrap phase (current):** SHAMIR_MIN temporarily set to 2 because not all validators have updated to compatible software (UID 2/Yuma stuck on v573, enforces threshold >= 7). The validator logs a warning instead of rejecting low thresholds, preventing backward-compatibility issues during rolling updates. Client distributes only to healthy validators.
**Target state:** Raise SHAMIR_MIN to 3 once all Djinn validators run compatible versions (>= v574). The floor of 3 prevents threshold=1 attacks.
**Reason:** With only 4 Djinn validators online (and only 2-3 on compatible software), a fixed threshold of 7 made signal creation impossible. The 2/3 majority requirement preserves the security property while adapting to network size.
**Impact:** Signal creation works with 2-10+ validators. Threshold scales from 2 (bootstrap) to 7 (at 10+), then stays at 7 forever.

## DEV-022: Refund Function Removed; Genius Retains Fee Pool

**Date:** 2026-03-13
**Whitepaper Section:** Section 7 — Economics, Section 6 — Settlement
**Whitepaper Says:** Implies fee refunds flow from the fee pool to idiots on negative scores.
**What we did:** Removed the dead `refund()` function from Escrow. Tranche A damages (USDC refunds to idiots) come from genius collateral slashing (see DEV-013), not from the fee pool. The genius retains the full fee pool via `claimFees()` regardless of settlement outcome. Damages and fees are separate economic pools.
**Why:** The refund function was never called by Audit settlement logic. Tranche A uses `collateral.slash(genius, amount, idiot)` to send USDC directly from collateral to the idiot. The fee pool represents the genius's earned revenue for providing the information service. Damages are a separate penalty backed by collateral. This separation is cleaner: the genius's revenue is their revenue; collateral is the performance bond.
**Impact:** Economic. Genius keeps fee pool even after negative audits. Idiot protection is unchanged (Tranche A comes from collateral, capped at fees paid).

## DEV-023: Protocol Fee Included in Collateral Lock

**Date:** 2026-03-13
**Whitepaper Section:** Section 7 — Collateral
**Whitepaper Says:** "Required collateral = Σ (notional × SLA%) across all active signals and all buyers."
**What we did:** Collateral lock at purchase time now includes both the SLA lock and the 0.5% protocol fee: `lockAmount = notional * slaMultiplierBps / 10000 + notional * 50 / 10000`. This ensures the genius always has sufficient collateral for the protocol fee at settlement.
**Why:** Audit finding CF-03 identified that without pre-locking the protocol fee, a genius with minimal free collateral could have insufficient funds at settlement time, resulting in a ProtocolFeeShortfall event with no actual fee collected.
**Impact:** Genius needs slightly more collateral per purchase (~0.5% more). Eliminates protocol fee shortfall risk.

## DEV-024: Withdrawal Freeze During Settlement

**Date:** 2026-03-13
**Whitepaper Section:** Section 7 — Collateral
**Whitepaper Says:** "Excess collateral can be withdrawn at any time."
**What we did:** Added `freezeWithdrawals()` / `unfreezeWithdrawals()` to Collateral. Audit settlement (`_settleCommon()`) freezes genius withdrawals before releasing locks and slashing, then unfreezes after settlement completes. This prevents front-running of settlement by withdrawing free collateral between lock release and slash.
**Why:** Audit finding CF-03. Without the freeze, a genius observing a pending settlement transaction could front-run it by withdrawing all free collateral, leaving insufficient funds for Tranche A damages and the protocol fee.
**Impact:** Genius withdrawals are blocked for the duration of a settlement transaction (single block). Negligible UX impact.

## DEV-025: OutcomeVoting Auto-Reset on Validator Set Change

**Date:** 2026-03-13
**Whitepaper Section:** Section 10 — Validators
**Whitepaper Says:** Validator consensus requires 2/3+ agreement.
**What we did:** Changed OutcomeVoting behavior when the validator set changes mid-vote. Previously (CF-05), any validator set change would permanently revert all subsequent votes for that cycle with `ValidatorSetChanged`. Now, when a vote detects a nonce mismatch, the cycle snapshot is cleared and re-initialized with the current validator set. Existing votes are preserved in storage but the quorum calculation restarts from scratch.
**Why:** The previous behavior could permanently brick cycles, requiring `forceSettle` through the 72-hour timelock. Auto-reset allows voting to resume with the new validator set without manual intervention.
**Impact:** Cycles are no longer permanently stuck by validator set changes. A validator set change during voting resets quorum progress, which may delay settlement but does not require emergency intervention.

## DEV-026: Account.qualityScore Renamed to outcomeBalance

**Date:** 2026-03-13
**Whitepaper Section:** Section 6 — Quality Score
**What we did:** Renamed the `qualityScore` field in Account.sol's AccountState struct to `outcomeBalance`. This field tracks a simple +1/-1 counter (favorable/unfavorable outcomes) and is unrelated to the USDC-denominated Quality Score computed by `Audit.computeScore()`.
**Why:** Audit finding CF-13. The name collision with the financial Quality Score could mislead off-chain consumers. "outcomeBalance" clearly indicates this is a directional outcome counter, not a dollar-denominated score.
**Impact:** Interface change. Subgraph and off-chain consumers reading AccountState must use `outcomeBalance` instead of `qualityScore`.

## DEV-027: SHAMIR_MAX Lowered from 7 to 3

**Date:** 2026-03-13
**Whitepaper Section:** Section 4 - Shamir Secret Sharing
**What we did:** Capped the maximum Shamir threshold at 3 (was 7). The formula `clamp(ceil(2/3 * healthy_validators), SHAMIR_MIN, SHAMIR_MAX)` now produces threshold <= 3.
**Why:** Only 3 validators (UID 2, 41, 189) reliably participate in direct peer-to-peer MPC communication. Other validators in the metagraph pass health checks via the Next.js proxy but are unreachable for direct MPC traffic. Signals created with threshold=7 cannot be purchased because the MPC protocol requires all threshold participants, and only 3 are available.
**Impact:** Lower security threshold during bootstrap. Will raise back to 7 once more validators come online with stable MPC connectivity. Temporary measure.

## DEV-028: Pluggable Sports Data Provider

**Date:** 2026-03-22
**Whitepaper Section:** Validators and Miners
**Whitepaper Says:** "Miners acquire their own data sources: paid odds APIs (e.g., The Odds API, OddsJam), direct sportsbook integrations, or their own scraping infrastructure."
**What we did:** Created a `SportsDataProvider` protocol in `miner/djinn_miner/data/provider.py` that defines the interface any sports data source must implement. The Odds API client (`OddsApiClient`) remains the default but is now one implementation of the protocol instead of being hardcoded. Miners can set `SPORTS_DATA_PROVIDER` to a custom module path (e.g. `my_module.MyProvider`) to load an alternative data source. The `ODDS_API_KEY` requirement is now conditional on using the default `odds_api` provider.
**Why:** The whitepaper explicitly states miners should bring their own data sources, but the codebase hardcoded The Odds API with no way to swap it out. This was the biggest adoption blocker ($59/month per miner for a paid API key). The validator scores miners via cross-miner consensus, not by checking against any specific API, so alternative data sources work naturally with the scoring system.
**Impact:** Miners can now use any data source that implements `get_odds()`, `parse_bookmaker_odds()`, `last_query_id`, and `close()`. Existing miners using The Odds API are unaffected.

## DEV-029: Dispute Resolution Deferred

**Date:** 2026-03-26
**Whitepaper Section:** Section 12 -- Dispute Resolution
**Whitepaper Says:** Outcome disputes are handled via staked challenges with a 48-hour finalization window, validator re-arbitration, and escalation to Yuma consensus. Score disputes use ZK re-computation.
**What we did:** Dispute resolution is not implemented. Current recourse mechanisms: (1) `OutcomeVoting.resetCycle()` allows the owner (TimelockController, 72h delay) to reset stuck voting cycles so validators can re-vote. (2) `Audit.forceSettle()` allows the owner to settle with a specified quality score as a last resort. (3) The 48-hour `FEE_CLAIM_DELAY` on `Escrow.claimFees()` provides a window to correct erroneous settlements before fees are withdrawn.
**Why:** The validator voting model (DEV-015) replaced ZK-based settlement, making ZK re-computation for score disputes inapplicable. The staked challenge mechanism adds significant contract complexity (new staking contract, challenge/response state machine, timeout handling) that is premature for the current network size (3 active validators). The existing admin controls via the 72h timelock provide sufficient dispute resolution for the bootstrap phase.
**Future:** Implement on-chain dispute resolution when the validator set grows beyond 10 and the protocol has mainnet USDC volume. The staked challenge model from the whitepaper remains the target design.
**Impact:** Users cannot permissionlessly dispute outcomes on-chain. Disputes must be raised off-chain and resolved via timelock governance. Acceptable during bootstrap but must be implemented before removing timelock admin powers.
