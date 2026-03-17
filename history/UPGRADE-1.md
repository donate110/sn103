# Upgrade 1: Audit Fix Batch (5 Proxy Upgrades)

**Date:** 2026-03-17
**Network:** Base Sepolia (testnet)
**Batch ID:** `0x1a48ff6c30a7617c39094688fed3028f05bc18c991ace4ec8e68de3c42f0c6ba`

## What This Is

Djinn Protocol uses UUPS upgradeable proxy contracts. The proxy addresses never change, but the implementation code behind them can be upgraded through a 72-hour timelock. This ensures nobody can change contract logic without a 3-day public waiting period.

A ProveAudit code audit (https://proveaudit.com/audit/GfXCxySgP3fI) found 33 issues. All 33 were fixed. New implementation contracts were deployed and a timelock batch was scheduled on 2026-03-13. The 72-hour delay elapsed on 2026-03-16 at 08:07 UTC. This execution is ~21 hours overdue.

## Pre-Upgrade State

**Block:** 38977710

### Proxy Addresses (unchanged by upgrade)
| Contract | Proxy Address |
|----------|--------------|
| Account | 0xbA02aAFaa497953Aa567Ecf12582996E74325a89 |
| Audit | 0x95002b53f4f53a27a060502fe1f026f74e9110e9 |
| Collateral | 0x47bcae6055dff70137336211be22f34c7a631626 |
| Escrow | 0x290E97c4B26ef1FdcF7BC27aFc43169B4a804a75 |
| OutcomeVoting | 0x4b140aA4BfB080337EE746f4Ec9e07ef660d80CF |

### Known Issue: OutcomeVoting Account Mismatch
OutcomeVoting's internal `account` reference points to `0x4f42F2c714adA4c55f2A967dDa6EFFA19E211deC`, not the live Account proxy (`0xbA02...`). This means settlement votes through OutcomeVoting cannot correctly call `account.settleAudit()`. The upgrade should fix this since the new OutcomeVoting implementation will be initialized with the correct Account address.

### Pre-Upgrade Contract Read Tests
- Escrow.usdc(): 0x7B8c... (correct USDC address)
- Account.getSignalCount(): functional
- Audit cross-refs: all correct (escrow, collateral, account, outcomeVoting)
- OutcomeVoting cross-refs: audit correct, **account WRONG**

## What the Upgrade Does

A single atomic transaction executes 11 operations through the TimelockController:

1. Pause Collateral
2. Pause Escrow
3. Pause Audit
4. Upgrade Account implementation
5. Upgrade Audit implementation
6. Upgrade Collateral implementation
7. Upgrade Escrow implementation
8. Upgrade OutcomeVoting implementation
9. Unpause Collateral
10. Unpause Escrow
11. Unpause Audit

### New Implementation Addresses
| Contract | New Implementation |
|----------|-------------------|
| Account | 0x1EB2802deebA22A2253934c5182E1eAD5c27fC99 |
| Audit | 0x002970FE844bEEe53b254cd60Da173534E0D74ab |
| Collateral | 0x82261eA3c66eD0988e2E96B4e429c976d3AdEdD6 |
| Escrow | 0xBF2Fc92eF93Fc0f9f6173A9F5df5Ff8984a3Fb49 |
| OutcomeVoting | 0x510CB7D80604C0F090987775c055e46E1bCf3C95 |

### Key Fixes in New Implementations
- ReentrancyGuard gas optimization
- Settlement ordering improvements
- Self-purchase prevention
- Validator set snapshot integrity
- Withdrawal freeze during settlement
- Collateral availability checks
- Paginated views for large datasets
- 33 total findings addressed

## Success Criteria

1. All 5 proxies point to new implementation addresses
2. Existing state preserved (balances, signals, relationships unchanged)
3. Escrow.usdc() still returns correct USDC address
4. Account.getSignalCount() still works
5. OutcomeVoting.account() points to the correct Account proxy
6. Contracts are unpaused and functional
7. Signal creation on djinn.gg still works

## Execution

### Attempt 1: Failed (batch hash mismatch)

The `ExecuteUpgrade.s.sol` script had 11 operations but the scheduled batch had 13 (included Account pause/unpause). Fixed the script to match.

### Attempt 2: Failed (wrong proxy addresses)

After fixing the op count, the batch hash still didn't match. Investigation revealed the scheduled batch targets the **old, stale proxy addresses** from a previous deployment:

| Contract | Scheduled Target (OLD) | Live Proxy (CURRENT) |
|----------|----------------------|---------------------|
| Collateral | 0x16C36aCe7aB4... | 0x47bcae6055df... |
| Escrow | 0x50A1Bf4eacED... | 0x290E97c4B26e... |
| Account | 0x5DDa635bbfC9... | 0xbA02aAFaa497... |
| Audit | 0x46F6DE92b4C3... | 0x95002b53f4f5... |
| OutcomeVoting | 0x28b5738ff35E... | 0x4b140aA4BfB0... |

The timelock batch was scheduled on 2026-03-13, before the contracts were redeployed to new proxy addresses. **This batch is obsolete.** Executing it would upgrade the old, unused proxies that djinn.gg no longer points to.

### Result: Upgrade NOT executed

**The 33 audit fixes from ProveAudit are not yet applied to the live contracts.** A new timelock batch needs to be scheduled against the current live proxy addresses, which means another 72-hour wait.

## Next Steps

1. Deploy new implementation contracts (may need to be recompiled if any code changed since 2026-03-13)
2. Schedule a new timelock batch targeting the live proxy addresses
3. Wait 72 hours for the timelock delay
4. Execute the new batch
5. Verify all cross-references (especially OutcomeVoting.account())

## Lessons Learned

- The timelock batch was scheduled before proxy addresses were finalized. When contracts were redeployed to new addresses, the scheduled batch became invalid.
- Future upgrades must verify that the timelock batch targets match the live proxy addresses before waiting 72 hours.
- The `ExecuteUpgrade.s.sol` script must exactly reproduce the scheduling script's operation count and parameters. A dry run (`forge script ... --rpc-url ... ` without `--broadcast`) should be used to verify the batch hash matches before executing.
