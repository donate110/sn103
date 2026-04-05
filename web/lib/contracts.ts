import { ethers } from "ethers";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function safeAddress(raw: string | undefined, fallback: string): string {
  const addr = raw ?? fallback;
  if (addr === ZERO_ADDRESS) return addr; // allow zero in dev
  try {
    return ethers.getAddress(addr);
  } catch {
    console.warn(`Invalid contract address "${addr}" — falling back to zero`);
    return ZERO_ADDRESS;
  }
}

// Contract addresses — populated from env vars or placeholder zeros
export const ADDRESSES = {
  signalCommitment: safeAddress(
    process.env.NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS,
    ZERO_ADDRESS
  ),
  escrow: safeAddress(process.env.NEXT_PUBLIC_ESCROW_ADDRESS, ZERO_ADDRESS),
  collateral: safeAddress(
    process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS,
    ZERO_ADDRESS
  ),
  creditLedger: safeAddress(
    process.env.NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS,
    ZERO_ADDRESS
  ),
  account: safeAddress(process.env.NEXT_PUBLIC_ACCOUNT_ADDRESS, ZERO_ADDRESS),
  audit: safeAddress(process.env.NEXT_PUBLIC_AUDIT_ADDRESS, ZERO_ADDRESS),
  keyRecovery: safeAddress(process.env.NEXT_PUBLIC_KEY_RECOVERY_ADDRESS, ZERO_ADDRESS),
  usdc: safeAddress(
    process.env.NEXT_PUBLIC_USDC_ADDRESS,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  ),
} as const;

// Warn in production if core contracts are not configured
if (typeof window !== "undefined" && process.env.NODE_ENV === "production") {
  const required = ["signalCommitment", "escrow", "collateral", "account", "audit"] as const;
  for (const name of required) {
    if (ADDRESSES[name] === ZERO_ADDRESS) {
      console.warn(`[Djinn] Contract address for ${name} is not configured (zero address). Set NEXT_PUBLIC_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}_ADDRESS.`);
    }
  }
}

// Warn if USDC address is the mainnet default but chain is testnet
const _chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
if (_chainId === 84532 && ADDRESSES.usdc === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") {
  console.warn(
    "[Djinn] NEXT_PUBLIC_USDC_ADDRESS is not set — using Base mainnet USDC address on testnet. " +
    "Set NEXT_PUBLIC_USDC_ADDRESS to your deployed MockUSDC contract address."
  );
}

// Minimal ABIs — only the functions used by the client

export const SIGNAL_COMMITMENT_ABI = [
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, bytes32 linesHash, uint16 lineCount, bool bpaMode) p) external",
  "function cancelSignal(uint256 signalId) external",
  "function getSignal(uint256 signalId) external view returns (tuple(address genius, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, uint8 status, uint256 createdAt, bytes32 linesHash, uint16 lineCount, bool bpaMode))",
  "function isActive(uint256 signalId) external view returns (bool)",
  "function signalExists(uint256 signalId) external view returns (bool)",
  "function isV2Signal(uint256 signalId) external view returns (bool)",
  "event SignalCommitted(uint256 indexed signalId, address indexed genius, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 expiresAt)",
  "event SignalCancelled(uint256 indexed signalId, address indexed genius)",
] as const;

export const ESCROW_ABI = [
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function purchase(uint256 signalId, uint256 notional, uint256 odds) external returns (uint256 purchaseId)",
  "function getBalance(address user) external view returns (uint256)",
  "function getPurchase(uint256 purchaseId) external view returns (tuple(address idiot, uint256 signalId, uint256 notional, uint256 feePaid, uint256 creditUsed, uint256 usdcPaid, uint256 odds, uint8 outcome, uint256 purchasedAt, uint256 lockedOdds))",
  "function getPurchasesBySignal(uint256 signalId) external view returns (uint256[])",
  "function getSignalNotionalFilled(uint256 signalId) external view returns (uint256)",
  "function signalNotionalFilled(uint256 signalId) external view returns (uint256)",
  "event Deposited(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event SignalPurchased(uint256 indexed signalId, address indexed buyer, uint256 purchaseId, uint256 notional, uint256 feePaid, uint256 creditUsed, uint256 usdcPaid)",
  "event OutcomeUpdated(uint256 indexed purchaseId, uint8 outcome)",
  "error ZeroAmount()",
  "error InsufficientBalance(uint256 available, uint256 required)",
  "error SignalNotActive(uint256 signalId)",
  "error SignalExpired(uint256 signalId)",
  "error AlreadyPurchased(uint256 signalId, address buyer)",
  "error OddsOutOfRange(uint256 odds)",
  "error NotionalTooSmall(uint256 notional, uint256 minimum)",
  "error NotionalTooLarge(uint256 notional, uint256 maximum)",
  "error NotionalExceedsSignalMax(uint256 notional, uint256 remaining)",
  "error ContractNotSet(string name)",
  "error InsufficientFreeCollateral(uint256 available, uint256 required)",
] as const;

export const COLLATERAL_ABI = [
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function getDeposit(address genius) external view returns (uint256)",
  "function getLocked(address genius) external view returns (uint256)",
  "function getAvailable(address genius) external view returns (uint256)",
  "event Deposited(address indexed genius, uint256 amount)",
  "event Withdrawn(address indexed genius, uint256 amount)",
] as const;

export const CREDIT_LEDGER_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
] as const;

export const ACCOUNT_ABI = [
  // v1 (cycle-based) functions -- still present in v2 as backwards-compat wrappers
  "function getAccountState(address genius, address idiot) external view returns (tuple(uint256 currentCycle, uint256 signalCount, int256 outcomeBalance, uint256[] purchaseIds, bool settled))",
  "function getCurrentCycle(address genius, address idiot) external view returns (uint256)",
  "function isAuditReady(address genius, address idiot) external view returns (bool)",
  "function getSignalCount(address genius, address idiot) external view returns (uint256)",
  // v2 (queue-based) functions
  "function getQueueState(address genius, address idiot) external view returns (tuple(uint256 totalPurchases, uint256 resolvedCount, uint256 auditedCount, uint256 auditBatchCount))",
  "function getPairPurchaseIds(address genius, address idiot) external view returns (uint256[])",
  "function getAuditBatchCount(address genius, address idiot) external view returns (uint256)",
  "function isPurchaseAudited(uint256 purchaseId) external view returns (bool)",
  // Events (shared across versions)
  "event PurchaseRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, uint256 signalCount)",
] as const;

export const AUDIT_ABI = [
  "event AuditSettled(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 trancheA, uint256 trancheB, uint256 protocolFee)",
  "event EarlyExitSettled(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 creditsAwarded)",
] as const;

export const KEY_RECOVERY_ABI = [
  "function storeRecoveryBlob(bytes blob) external",
  "function getRecoveryBlob(address user) external view returns (bytes)",
  "event RecoveryBlobStored(address indexed user, uint256 timestamp)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
] as const;

// Contract factory helpers

export function getSignalCommitmentContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.signalCommitment,
    SIGNAL_COMMITMENT_ABI,
    signerOrProvider
  );
}

export function getEscrowContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.escrow,
    ESCROW_ABI,
    signerOrProvider
  );
}

export function getCollateralContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.collateral,
    COLLATERAL_ABI,
    signerOrProvider
  );
}

export function getCreditLedgerContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.creditLedger,
    CREDIT_LEDGER_ABI,
    signerOrProvider
  );
}

export function getAccountContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.account,
    ACCOUNT_ABI,
    signerOrProvider
  );
}

export function getAuditContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.audit,
    AUDIT_ABI,
    signerOrProvider
  );
}

export function getKeyRecoveryContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.keyRecovery,
    KEY_RECOVERY_ABI,
    signerOrProvider
  );
}

export function getUsdcContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.usdc,
    ERC20_ABI,
    signerOrProvider
  );
}

// ---------------------------------------------------------------------------
// Contract version detection (v1 cycle-based vs v2 queue-based)
// ---------------------------------------------------------------------------

export type ContractVersion = 1 | 2;

let _cachedVersion: ContractVersion | null = null;

/**
 * Detects whether the deployed Account contract is v1 (cycle-based) or v2
 * (queue-based) by probing for the v2-only `getAuditBatchCount` function.
 * Result is cached for the lifetime of the page.
 */
export async function detectContractVersion(
  provider: ethers.Provider,
): Promise<ContractVersion> {
  if (_cachedVersion !== null) return _cachedVersion;

  try {
    const contract = getAccountContract(provider);
    // Call with zero addresses; we only care whether the function exists, not the result
    await contract.getAuditBatchCount(ethers.ZeroAddress, ethers.ZeroAddress);
    _cachedVersion = 2;
  } catch {
    // Function doesn't exist or reverted: v1
    _cachedVersion = 1;
  }

  return _cachedVersion;
}

/** Returns the cached version if already detected, otherwise null. */
export function getCachedContractVersion(): ContractVersion | null {
  return _cachedVersion;
}
