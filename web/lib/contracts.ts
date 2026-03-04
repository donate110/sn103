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
  trackRecord: safeAddress(process.env.NEXT_PUBLIC_TRACK_RECORD_ADDRESS, ZERO_ADDRESS),
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

// Minimal ABIs — only the functions used by the client

export const SIGNAL_COMMITMENT_ABI = [
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks) p) external",
  "function cancelSignal(uint256 signalId) external",
  "function getSignal(uint256 signalId) external view returns (tuple(address genius, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, uint8 status, uint256 createdAt))",
  "function isActive(uint256 signalId) external view returns (bool)",
  "function signalExists(uint256 signalId) external view returns (bool)",
  "event SignalCommitted(uint256 indexed signalId, address indexed genius, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 expiresAt)",
  "event SignalCancelled(uint256 indexed signalId, address indexed genius)",
] as const;

export const ESCROW_ABI = [
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function purchase(uint256 signalId, uint256 notional, uint256 odds) external returns (uint256 purchaseId)",
  "function getBalance(address user) external view returns (uint256)",
  "function getPurchase(uint256 purchaseId) external view returns (tuple(address idiot, uint256 signalId, uint256 notional, uint256 feePaid, uint256 creditUsed, uint256 usdcPaid, uint256 odds, uint8 outcome, uint256 purchasedAt))",
  "function getPurchasesBySignal(uint256 signalId) external view returns (uint256[])",
  "function getSignalNotionalFilled(uint256 signalId) external view returns (uint256)",
  "function signalNotionalFilled(uint256 signalId) external view returns (uint256)",
  "event Deposited(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event SignalPurchased(uint256 indexed signalId, address indexed buyer, uint256 purchaseId, uint256 notional, uint256 feePaid, uint256 creditUsed, uint256 usdcPaid)",
  "event OutcomeUpdated(uint256 indexed purchaseId, uint8 outcome)",
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
  "function getAccountState(address genius, address idiot) external view returns (tuple(uint256 currentCycle, uint256 signalCount, int256 qualityScore, uint256[] purchaseIds, bool settled))",
  "function getCurrentCycle(address genius, address idiot) external view returns (uint256)",
  "function isAuditReady(address genius, address idiot) external view returns (bool)",
  "function getSignalCount(address genius, address idiot) external view returns (uint256)",
  "event PurchaseRecorded(address indexed genius, address indexed idiot, uint256 purchaseId, uint256 signalCount)",
] as const;

export const AUDIT_ABI = [
  "event AuditSettled(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 trancheA, uint256 trancheB, uint256 protocolFee)",
  "event EarlyExitSettled(address indexed genius, address indexed idiot, uint256 cycle, int256 qualityScore, uint256 creditsAwarded)",
] as const;

export const TRACK_RECORD_ABI = [
  "function commitProof(bytes32 commitHash) external",
  "function submit(uint256[2] _pA, uint256[2][2] _pB, uint256[2] _pC, uint256[106] _pubSignals) external returns (uint256 recordId)",
  "function getRecord(uint256 recordId) external view returns (tuple(address genius, uint256 signalCount, uint256 totalGain, uint256 totalLoss, uint256 favCount, uint256 unfavCount, uint256 voidCount, bytes32 proofHash, uint256 submittedAt, uint256 blockNumber))",
  "function getRecordCount(address genius) external view returns (uint256)",
  "function getRecordIds(address genius) external view returns (uint256[])",
  "function COMMIT_EXPIRY_BLOCKS() external view returns (uint256)",
  "event ProofCommitted(address indexed genius, bytes32 commitHash, uint256 blockNumber)",
  "event TrackRecordSubmitted(uint256 indexed recordId, address indexed genius, uint256 signalCount, uint256 totalGain, uint256 totalLoss, uint256 favCount, uint256 unfavCount, uint256 voidCount, bytes32 proofHash)",
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

export function getTrackRecordContract(
  signerOrProvider: ethers.Signer | ethers.Provider
) {
  return new ethers.Contract(
    ADDRESSES.trackRecord,
    TRACK_RECORD_ABI,
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
