# Mainnet Deployment Checklist

This checklist exists because testnet deployments went wrong in ways that were hard to detect. Every step has a verification gate. Do not proceed to the next step until the gate passes.

## Pre-Deploy

- [ ] All contract tests pass: `forge test`
- [ ] All contracts compile clean: `forge build --force`
- [ ] ProveAudit grade is A or A+
- [ ] Deployer wallet has enough ETH for gas on Base mainnet
- [ ] USDC address on Base mainnet confirmed (not testnet MockUSDC)
- [ ] `.env.mainnet` prepared with RPC URL, chain ID 8453, deployer key

## Step 1: Deploy Implementations

Run `Deploy.s.sol` with `--broadcast`.

**Verification gate:** For each contract (Account, Audit, Collateral, CreditLedger, Escrow, KeyRecovery, OutcomeVoting, SignalCommitment), confirm the implementation address exists on-chain:
```bash
cast code <IMPL_ADDRESS> --rpc-url $RPC_URL | wc -c
# Must be > 1000 bytes (full contract code)
```

## Step 2: Verify Every Proxy Was Created

The deploy script creates ERC1967Proxy for each contract. The PROXY address (not the implementation address) is what goes in env vars.

**Verification gate:** For each proxy address, check the EIP-1967 implementation slot:
```bash
cast storage <PROXY_ADDRESS> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC_URL
# Must return a non-zero address matching the implementation from Step 1
```

Also confirm proxy code is small (~200 bytes, just the delegation stub):
```bash
cast code <PROXY_ADDRESS> --rpc-url $RPC_URL | wc -c
# Must be < 1000 bytes
```

**If any proxy returns zero implementation or large code size: STOP. The contract was deployed directly, not through a proxy. Redeploy it correctly.**

## Step 3: Verify Cross-References

Contracts reference each other. All references must point to PROXY addresses, not implementations.

```bash
# From Audit: should return the proxy addresses
cast call <AUDIT_PROXY> "escrow()(address)" --rpc-url $RPC_URL
cast call <AUDIT_PROXY> "collateral()(address)" --rpc-url $RPC_URL
cast call <AUDIT_PROXY> "account()(address)" --rpc-url $RPC_URL
cast call <AUDIT_PROXY> "outcomeVoting()(address)" --rpc-url $RPC_URL

# From OutcomeVoting: must match
cast call <OV_PROXY> "audit()(address)" --rpc-url $RPC_URL
cast call <OV_PROXY> "account()(address)" --rpc-url $RPC_URL

# From Escrow
cast call <ESCROW_PROXY> "signalCommitment()(address)" --rpc-url $RPC_URL
cast call <ESCROW_PROXY> "usdc()(address)" --rpc-url $RPC_URL
cast call <ESCROW_PROXY> "account()(address)" --rpc-url $RPC_URL
```

**Verification gate:** Every returned address matches the corresponding proxy address from Step 2. No mismatches. No old addresses.

## Step 4: Verify TimelockController Ownership

```bash
# Each proxy's owner should be the TimelockController
cast call <ACCOUNT_PROXY> "owner()(address)" --rpc-url $RPC_URL
cast call <ESCROW_PROXY> "owner()(address)" --rpc-url $RPC_URL
cast call <COLLATERAL_PROXY> "owner()(address)" --rpc-url $RPC_URL
cast call <AUDIT_PROXY> "owner()(address)" --rpc-url $RPC_URL
cast call <OV_PROXY> "owner()(address)" --rpc-url $RPC_URL
# All must return the TimelockController address
```

**Verification gate:** All contracts owned by the TimelockController. Nobody can upgrade without 72h public notice.

## Step 5: Functional Smoke Test

Before updating any config, verify core operations work through the proxy:
```bash
# Mint test USDC and try a collateral deposit
# Create a signal
# Verify the signal appears on-chain
# Purchase the signal
# Cancel the signal
```

**Verification gate:** End-to-end flow works through proxy addresses.

## Step 6: Update All Config Simultaneously

Do these together, not days apart:

1. **Vercel env vars**: Update all `NEXT_PUBLIC_*_ADDRESS` variables
2. **Validator config.py defaults**: Update all addresses in the code
3. **Validator .env on VPS**: Remove old overrides (let code defaults take over)
4. **Commit and push** the config.py changes
5. **Restart validator** with `--update-env`

**Verification gate:**
- `djinn.gg` loads, wallet connects, balances show
- Validator health check returns `chain_connected: true`
- Signal creation works end-to-end on djinn.gg

## Step 7: Record Addresses

Write all proxy addresses to:
- `contracts/DEPLOYMENTS.md` (checked into git)
- Project memory
- This checklist (fill in below)

### Mainnet Addresses (fill in after deploy)
```
Chain: Base (8453)
TimelockController:
Account proxy:
Audit proxy:
Collateral proxy:
CreditLedger proxy:
Escrow proxy:
KeyRecovery proxy:
OutcomeVoting proxy:
SignalCommitment proxy:
USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Base native USDC)
```

## What Went Wrong on Testnet (Lessons)

1. **RedeployEscrow/RedeployAccount created bare contracts, not proxied ones.** The scripts used `new Escrow()` instead of `new ERC1967Proxy(impl, initData)`. Nobody checked the EIP-1967 slot after deploy.

2. **Vercel env vars and local .env diverged.** Vercel pointed at one set of addresses, local dev pointed at another, and the timelock upgrade was scheduled against a third. Three separate deployments, nobody tracking which was "real."

3. **No verification step after deploy.** If anyone had run `cast storage <addr> <impl_slot>` on the live addresses, the missing proxy would have been caught immediately.

4. **The fix for mainnet:** Every step has a verification gate. No proceeding without confirmation. Addresses recorded in one canonical place.

## Future Upgrades (after mainnet deploy)

1. Deploy new implementation contract(s)
2. Schedule timelock batch: `UpgradeAuditFixes.s.sol` with PROXY addresses from Step 7
3. **Verify batch targets match the proxy addresses above** (dry run without --broadcast)
4. Wait 72 hours
5. Execute: `ExecuteUpgrade.s.sol` (dry run first, verify batch hash matches)
6. **Verify EIP-1967 slot now points to new implementation**
7. Smoke test: signal creation, purchase, settlement still work
8. No validator config changes needed (proxy addresses never change)
