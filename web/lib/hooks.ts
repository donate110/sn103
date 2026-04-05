"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { useAccount, useWalletClient } from "wagmi";
import { parseAbi, keccak256, encodePacked, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { waitForTransactionReceipt, getBlockNumber } from "@wagmi/core";
import { wagmiConfig } from "../app/providers";
import {
  getSignalCommitmentContract,
  getEscrowContract,
  getCollateralContract,
  getCreditLedgerContract,
  getUsdcContract,
  ADDRESSES,
} from "./contracts";
import type { Signal, CommitParams } from "./types";

// ---------------------------------------------------------------------------
// Debug logging — only emits in development
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV === "development";
const debug: (...args: unknown[]) => void = isDev
  ? (...args: unknown[]) => console.log(...args)
  : () => {};

// ---------------------------------------------------------------------------
// Error humanization — turn raw contract errors into readable messages
// ---------------------------------------------------------------------------

const REVERT_PATTERNS: [RegExp, string][] = [
  [/missing revert data/i, "Contract not deployed. The protocol contracts need to be deployed before you can transact."],
  [/could not detect network/i, "Cannot connect to the blockchain. Check your network connection."],
  [/CALL_EXCEPTION.*data=null/i, "Contract not deployed. The protocol contracts need to be deployed before you can transact."],
  [/InsufficientFreeCollateral/i, "Genius doesn't have enough collateral deposited for this signal's SLA"],
  [/InsufficientBalance/i, "Insufficient escrow balance: deposit more USDC before purchasing"],
  [/Insufficient collateral/i, "You don't have enough collateral deposited"],
  [/Insufficient balance/i, "Insufficient USDC balance"],
  [/Insufficient escrow/i, "Not enough funds in your escrow account"],
  [/SignalNotActive/i, "This signal is no longer active"],
  [/SignalExpired/i, "This signal has expired"],
  [/Signal expired/i, "This signal has expired"],
  [/Signal does not exist/i, "Signal not found on-chain"],
  [/AlreadyPurchased/i, "You've already purchased this signal"],
  [/Already purchased/i, "You've already purchased this signal"],
  [/Already committed/i, "This signal was already committed"],
  [/NotionalTooSmall/i, "Notional amount is below the minimum"],
  [/NotionalTooLarge/i, "Notional amount exceeds the maximum"],
  [/NotionalExceedsSignalMax/i, "Notional exceeds this signal's remaining capacity"],
  [/OddsOutOfRange/i, "Odds are out of the valid range"],
  [/ZeroAmount/i, "Amount cannot be zero"],
  [/ContractNotSet/i, "Protocol contract not configured (contact admin)"],
  [/CycleSignalLimitReached/i, "You've reached the signal purchase limit for this genius (10 max per audit batch)"],
  [/InsufficientFreeCollateral/i, "Genius does not have enough free collateral for this signal"],
  [/Not genius/i, "Only the signal creator can perform this action"],
  [/Transfer amount exceeds allowance/i, "USDC approval needed, please approve the transfer first"],
  [/Transfer amount exceeds balance/i, "Insufficient USDC balance in your wallet"],
  [/user rejected/i, "Transaction cancelled by user"],
  [/user denied/i, "Transaction cancelled by user"],
  [/ACTION_REJECTED/i, "Transaction cancelled by user"],
  [/nonce.*already.*used/i, "Transaction nonce conflict, please wait and try again"],
  [/replacement.*underpriced/i, "Gas price too low, try increasing gas"],
  [/insufficient funds for gas/i, "Not enough ETH to cover gas fees. Get testnet ETH from a faucet."],
  [/No request found/i, "Wallet lost track of the request, please try again"],
  [/chain.*mismatch|wrong.*network|Wrong network/i, "Wrong network: switch to Base Sepolia in your wallet settings."],
  [/execution reverted/i, "Transaction reverted on-chain, check your balances and try again"],
];

/** Convert a raw transaction error to a user-friendly message. */
export function humanizeError(err: unknown, fallback = "Transaction failed"): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message;

  for (const [pattern, readable] of REVERT_PATTERNS) {
    if (pattern.test(msg)) return readable;
  }

  // Extract revert reason if present
  const revertMatch = msg.match(/reason="([^"]+)"/);
  if (revertMatch) return revertMatch[1];

  // Extract error string from reverted call
  const execMatch = msg.match(/execution reverted:\s*"?([^"]+)"?/);
  if (execMatch) return execMatch[1];

  // For generic contract errors, clean up the message
  // But preserve validator/miner distribution errors (they have useful detail)
  if (msg.length > 200 && !msg.includes("distribution failed")) return fallback;

  return msg;
}

// ---------------------------------------------------------------------------
// Chain ID — expected chain for all transactions (Base Sepolia: 84532, Base: 8453)
// ---------------------------------------------------------------------------

const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const expectedChain = EXPECTED_CHAIN_ID === 8453 ? base : baseSepolia;

/** Throw a descriptive error if the wallet is on the wrong chain. */
function assertCorrectChain(walletClient: { chain?: { id: number } }) {
  const chainId = walletClient.chain?.id;
  // Only block if we positively know the chain is wrong. Skip if chain info
  // is unavailable (e.g. in tests or wallets that don't expose it).
  if (chainId !== undefined && chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong network: please switch to ${expectedChain.name} (chain ID ${EXPECTED_CHAIN_ID}) in your wallet.`
    );
  }
}

// ---------------------------------------------------------------------------
// Read-only provider — uses public RPC for reliable reads
// ---------------------------------------------------------------------------

const READ_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org";
let _readProvider: ethers.JsonRpcProvider | null = null;

export function getReadProvider(): ethers.JsonRpcProvider {
  if (!_readProvider) {
    _readProvider = new ethers.JsonRpcProvider(READ_RPC_URL, EXPECTED_CHAIN_ID, { staticNetwork: true });
  }
  return _readProvider;
}

// ---------------------------------------------------------------------------
// Provider & signer hooks — uses wagmi wallet client for signing
// ---------------------------------------------------------------------------

export function useEthersProvider(): ethers.BrowserProvider | null {
  const { data: walletClient } = useWalletClient();
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);

  useEffect(() => {
    if (!walletClient) {
      setProvider(null);
      return;
    }
    // Pass walletClient itself as the EIP-1193 provider — its request()
    // method routes signing through the wallet (Coinbase Smart Wallet popup,
    // MetaMask extension, etc.). Using walletClient.transport only gives
    // read-only RPC access and cannot sign transactions.
    const ethProvider = new ethers.BrowserProvider(
      walletClient as unknown as ethers.Eip1193Provider,
      EXPECTED_CHAIN_ID,
    );
    setProvider(ethProvider);
  }, [walletClient]);

  return provider;
}

export function useEthersSigner(): ethers.Signer | null {
  const provider = useEthersProvider();
  const [signer, setSigner] = useState<ethers.Signer | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (provider) {
      provider.getSigner().then((s) => {
        if (!cancelled) setSigner(s);
      }).catch((err) => {
        console.error("[useEthersSigner] getSigner failed:", err);
        if (!cancelled) setSigner(null);
      });
    } else {
      setSigner(null);
    }
    return () => { cancelled = true; };
  }, [provider]);

  return signer;
}

/** Check if the wallet is on the expected chain. */
export function useChainId(): { chainId: number | null; isCorrectChain: boolean } {
  const { chainId: wagmiChainId } = useAccount();
  const chainId = wagmiChainId ? Number(wagmiChainId) : null;
  return { chainId, isCorrectChain: chainId === EXPECTED_CHAIN_ID };
}

// ---------------------------------------------------------------------------
// Wallet USDC balance hook — raw USDC in the user's wallet (not deposited)
// ---------------------------------------------------------------------------

export function useWalletUsdcBalance(address: string | undefined) {
  const [balance, setBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setBalance(0n);
      return;
    }
    setLoading(true);
    try {
      const usdc = getUsdcContract(getReadProvider());
      const bal = await usdc.balanceOf(address);
      if (!cancelledRef.current) setBalance(BigInt(bal));
    } catch {
      // Silently fail — wallet balance is informational
      if (!cancelledRef.current) setBalance(0n);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  return { balance, loading, refresh };
}

// ---------------------------------------------------------------------------
// Escrow balance hook
// ---------------------------------------------------------------------------

export function useEscrowBalance(address: string | undefined) {
  const [balance, setBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setBalance(0n);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const contract = getEscrowContract(getReadProvider());
      const bal = await contract.getBalance(address);
      if (!cancelledRef.current) setBalance(BigInt(bal));
    } catch (err) {
      if (!cancelledRef.current) {
        const msg = err instanceof Error ? err.message : "Failed to fetch escrow balance";
        setError(msg);
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  return { balance, loading, refresh, error };
}

// ---------------------------------------------------------------------------
// Credit balance hook
// ---------------------------------------------------------------------------

export function useCreditBalance(address: string | undefined) {
  const [balance, setBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setBalance(0n);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const contract = getCreditLedgerContract(getReadProvider());
      const bal = await contract.balanceOf(address);
      if (!cancelledRef.current) setBalance(BigInt(bal));
    } catch (err) {
      if (!cancelledRef.current) {
        const msg = err instanceof Error ? err.message : "Failed to fetch credit balance";
        setError(msg);
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  return { balance, loading, refresh, error };
}

// ---------------------------------------------------------------------------
// Collateral hooks
// ---------------------------------------------------------------------------

export function useCollateral(address: string | undefined) {
  const [deposit, setDeposit] = useState<bigint>(0n);
  const [locked, setLocked] = useState<bigint>(0n);
  const [available, setAvailable] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setDeposit(0n);
      setLocked(0n);
      setAvailable(0n);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const contract = getCollateralContract(getReadProvider());
      const [d, l, a] = await Promise.all([
        contract.getDeposit(address),
        contract.getLocked(address),
        contract.getAvailable(address),
      ]);
      if (!cancelledRef.current) {
        setDeposit(BigInt(d));
        setLocked(BigInt(l));
        setAvailable(BigInt(a));
      }
    } catch (err) {
      if (!cancelledRef.current) {
        const msg = err instanceof Error ? err.message : "Failed to fetch collateral";
        setError(msg);
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => { cancelledRef.current = true; };
  }, [refresh]);

  return { deposit, locked, available, loading, refresh, error };
}

// ---------------------------------------------------------------------------
// Signal query hook
// ---------------------------------------------------------------------------

export function useSignal(signalId: bigint | undefined) {
  const [signal, setSignal] = useState<Signal | null>(null);
  // Start loading=true when signalId is defined to prevent a brief flash of
  // "Signal not found" during React hydration (before useEffect fires).
  const [loading, setLoading] = useState(signalId !== undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (signalId === undefined) {
      setSignal(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const contract = getSignalCommitmentContract(getReadProvider());
    const toBigInt = (v: unknown): bigint => {
      if (typeof v === "bigint") return v;
      if (typeof v === "number" || typeof v === "string") return BigInt(v);
      return 0n;
    };
    const parseSignal = (raw: Record<string, unknown>): Signal => ({
      genius: String(raw.genius ?? ""),
      encryptedBlob: String(raw.encryptedBlob ?? ""),
      commitHash: String(raw.commitHash ?? ""),
      sport: String(raw.sport ?? ""),
      maxPriceBps: toBigInt(raw.maxPriceBps),
      slaMultiplierBps: toBigInt(raw.slaMultiplierBps),
      maxNotional: toBigInt(raw.maxNotional),
      minNotional: toBigInt(raw.minNotional),
      expiresAt: toBigInt(raw.expiresAt),
      decoyLines: Array.isArray(raw.decoyLines) ? raw.decoyLines.map(String) : [],
      availableSportsbooks: Array.isArray(raw.availableSportsbooks) ? raw.availableSportsbooks.map(String) : [],
      status: Number(raw.status ?? 0),
      createdAt: toBigInt(raw.createdAt),
      linesHash: String(raw.linesHash || "0x" + "0".repeat(64)),
      lineCount: Number(raw.lineCount || 0),
      bpaMode: Boolean(raw.bpaMode),
    });
    const fetchWithRetry = async (retries = 2, delayMs = 3000): Promise<void> => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const raw = await contract.getSignal(signalId);
          if (cancelled) return;
          const parsed = parseSignal(raw as Record<string, unknown>);
          // A signal with genius=0x0 or empty sport means it doesn't exist on-chain
          if (parsed.genius === "0x0000000000000000000000000000000000000000" || !parsed.sport) {
            throw new Error("Signal not found on-chain");
          }
          setSignal(parsed);
          return;
        } catch (err) {
          if (cancelled) return;
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          setError(err instanceof Error ? err.message : "Failed to load signal");
        }
      }
    };
    fetchWithRetry().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [signalId]);

  return { signal, loading, error };
}

// ---------------------------------------------------------------------------
// Gas estimation utility
// ---------------------------------------------------------------------------

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice: bigint;
  totalCostWei: bigint;
  totalCostEth: string; // Human-readable ETH cost
}

/** Estimate gas for a contract method call. Returns null if estimation fails. */
export async function estimateGas(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
): Promise<GasEstimate | null> {
  try {
    const provider = contract.runner as ethers.Signer;
    const gasLimit = await contract[method].estimateGas(...args);
    const feeData = await (provider as unknown as { provider: ethers.Provider }).provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const totalCostWei = gasLimit * gasPrice;
    const totalCostEth = ethers.formatEther(totalCostWei);

    return {
      gasLimit,
      gasPrice,
      totalCostWei,
      totalCostEth,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Viem ABI fragments for write operations
// ---------------------------------------------------------------------------

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const ESCROW_ABI = parseAbi([
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function purchase(uint256 signalId, uint256 notional, uint256 odds) returns (uint256 purchaseId)",
]);

const COLLATERAL_ABI = parseAbi([
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
]);

const SIGNAL_COMMITMENT_VIEM_ABI = parseAbi([
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, bytes32 linesHash, uint16 lineCount, bool bpaMode) p)",
  "function cancelSignal(uint256 signalId)",
]);

const AUDIT_VIEM_ABI = parseAbi([
  "function earlyExit(address genius, address idiot)",
]);

/** Wait for a tx hash to be confirmed, throw if reverted. */
async function waitForTx(hash: Hex): Promise<void> {
  const receipt = await waitForTransactionReceipt(wagmiConfig, {
    hash,
    timeout: 120_000, // 2 minutes — prevents indefinite hang with Coinbase Smart Wallet
  });
  if (receipt.status === "reverted") throw new Error("Transaction reverted on-chain");
}

// ---------------------------------------------------------------------------
// Transaction hooks
// ---------------------------------------------------------------------------

export function useCommitSignal() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const commit = useCallback(
    async (params: CommitParams) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      setTxHash(null);
      try {
        const signalCommitmentAddr = ADDRESSES.signalCommitment as Hex;

        debug("[commit-signal] committing signal", params.signalId.toString());
        const hash = await walletClient.writeContract({
          address: signalCommitmentAddr,
          abi: SIGNAL_COMMITMENT_VIEM_ABI,
          functionName: "commit",
          account: address,
          chain: expectedChain,
          args: [{
            signalId: params.signalId,
            encryptedBlob: params.encryptedBlob as Hex,
            commitHash: params.commitHash as Hex,
            sport: params.sport,
            maxPriceBps: params.maxPriceBps,
            slaMultiplierBps: params.slaMultiplierBps,
            maxNotional: params.maxNotional,
            minNotional: params.minNotional,
            expiresAt: params.expiresAt,
            decoyLines: params.decoyLines,
            availableSportsbooks: params.availableSportsbooks,
            linesHash: (params.linesHash || "0x" + "0".repeat(64)) as Hex,
            lineCount: params.lineCount || 0,
            bpaMode: params.bpaMode || false,
          }],
        });
        debug("[commit-signal] tx:", hash);
        setTxHash(hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        console.error("[commit-signal] FAILED:", err);
        setError(humanizeError(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  return { commit, loading, error, txHash };
}

export function usePurchaseSignal() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const purchase = useCallback(
    async (signalId: bigint, notional: bigint, odds: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      setTxHash(null);
      try {
        const escrowAddr = ADDRESSES.escrow as Hex;

        debug("[purchase-signal] purchasing signal", signalId.toString());
        const hash = await walletClient.writeContract({
          address: escrowAddr,
          abi: ESCROW_ABI,
          functionName: "purchase",
          account: address,
          chain: expectedChain,
          args: [signalId, notional, odds],
        });
        debug("[purchase-signal] tx:", hash);
        setTxHash(hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        console.error("[purchase-signal] FAILED:", err);
        setError(humanizeError(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  return { purchase, loading, error, txHash };
}

export function useDepositEscrow() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const justApprovedRef = useRef(false);

  const deposit = useCallback(
    async (amount: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      try {
        const usdcAddr = ADDRESSES.usdc as Hex;
        const escrowAddr = ADDRESSES.escrow as Hex;

        // Pre-check balance via read provider
        const usdcRead = getUsdcContract(getReadProvider());
        const balance = await usdcRead.balanceOf(address);
        if (balance < amount) {
          throw new Error(`Insufficient USDC balance: have ${balance}, need ${amount}`);
        }

        // Skip allowance check if we just approved (RPC may lag behind on-chain state)
        if (!justApprovedRef.current) {
          const allowance: bigint = await usdcRead.allowance(address, escrowAddr);
          if (allowance < amount) {
            // Coinbase Smart Wallet can only handle one popup per user action.
            // Do ONLY the approve here, then return. Caller clicks again for deposit.
            const MAX_UINT256 = 2n ** 256n - 1n;
            debug("[escrow-deposit] approving (max allowance)");
            const approveHash = await walletClient.writeContract({
              address: usdcAddr,
              abi: ERC20_ABI,
              functionName: "approve",
              account: address,
              chain: expectedChain,
              args: [escrowAddr, MAX_UINT256],
            });
            debug("[escrow-deposit] approve tx:", approveHash);
            await waitForTx(approveHash);
            setNeedsApproval(false);
            justApprovedRef.current = true;
            return "approved" as const;
          }
        }

        // Deposit into escrow (single popup)
        justApprovedRef.current = false;
        debug("[escrow-deposit] depositing", amount.toString());
        const depositHash = await walletClient.writeContract({
          address: escrowAddr,
          abi: ESCROW_ABI,
          functionName: "deposit",
          account: address,
          chain: expectedChain,
          args: [amount],
        });
        debug("[escrow-deposit] deposit tx:", depositHash);
        await waitForTx(depositHash);

        return depositHash;
      } catch (err) {
        console.error("[escrow-deposit] FAILED:", err);
        justApprovedRef.current = false;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Deposit failed: ${msg}`);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  // Check approval state on mount and after deposit
  const checkApproval = useCallback(async (amount: bigint) => {
    if (!address) return;
    try {
      const usdcRead = getUsdcContract(getReadProvider());
      const escrowAddr = ADDRESSES.escrow as Hex;
      const allowance: bigint = await usdcRead.allowance(address, escrowAddr);
      setNeedsApproval(allowance < amount);
    } catch { /* ignore */ }
  }, [address]);

  return { deposit, loading, error, needsApproval, checkApproval };
}

export function useDepositCollateral() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const justApprovedRef = useRef(false);

  const deposit = useCallback(
    async (amount: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      try {
        const usdcAddr = ADDRESSES.usdc as Hex;
        const collateralAddr = ADDRESSES.collateral as Hex;

        // Pre-check balance via read provider
        const usdcRead = getUsdcContract(getReadProvider());
        const balance = await usdcRead.balanceOf(address);
        if (balance < amount) {
          throw new Error(`Insufficient USDC balance: have ${balance}, need ${amount}`);
        }

        // Skip allowance check if we just approved (RPC may lag behind on-chain state)
        if (!justApprovedRef.current) {
          const allowance: bigint = await usdcRead.allowance(address, collateralAddr);
          if (allowance < amount) {
            // Coinbase Smart Wallet can only handle one popup per user action.
            // Do ONLY the approve here, then return. Caller clicks again for deposit.
            const MAX_UINT256 = 2n ** 256n - 1n;
            debug("[collateral-deposit] approving (max allowance)");
            const approveHash = await walletClient.writeContract({
              address: usdcAddr,
              abi: ERC20_ABI,
              functionName: "approve",
              account: address,
              chain: expectedChain,
              args: [collateralAddr, MAX_UINT256],
            });
            debug("[collateral-deposit] approve tx:", approveHash);
            await waitForTx(approveHash);
            setNeedsApproval(false);
            justApprovedRef.current = true;
            return "approved" as const;
          }
        }

        // Deposit into collateral (single popup)
        justApprovedRef.current = false;
        debug("[collateral-deposit] depositing", amount.toString());
        const depositHash = await walletClient.writeContract({
          address: collateralAddr,
          abi: COLLATERAL_ABI,
          functionName: "deposit",
          account: address,
          chain: expectedChain,
          args: [amount],
        });
        debug("[collateral-deposit] deposit tx:", depositHash);
        await waitForTx(depositHash);

        return depositHash;
      } catch (err) {
        console.error("[collateral-deposit] FAILED:", err);
        justApprovedRef.current = false;
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Deposit failed: ${msg}`);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  const checkApproval = useCallback(async (amount: bigint) => {
    if (!address) return;
    try {
      const usdcRead = getUsdcContract(getReadProvider());
      const collateralAddr = ADDRESSES.collateral as Hex;
      const allowance: bigint = await usdcRead.allowance(address, collateralAddr);
      setNeedsApproval(allowance < amount);
    } catch { /* ignore */ }
  }, [address]);

  return { deposit, loading, error, needsApproval, checkApproval };
}

// ---------------------------------------------------------------------------
// Withdraw hooks
// ---------------------------------------------------------------------------

export function useWithdrawEscrow() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(
    async (amount: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      try {
        const escrowAddr = ADDRESSES.escrow as Hex;
        debug("[escrow-withdraw] withdrawing", amount.toString());
        const hash = await walletClient.writeContract({
          address: escrowAddr,
          abi: ESCROW_ABI,
          functionName: "withdraw",
          account: address,
          chain: expectedChain,
          args: [amount],
          gas: 200_000n,
        });
        debug("[escrow-withdraw] tx:", hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        console.error("[escrow-withdraw] FAILED:", err);
        setError(humanizeError(err, "Withdraw failed"));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  return { withdraw, loading, error };
}

export function useWithdrawCollateral() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withdraw = useCallback(
    async (amount: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      try {
        const collateralAddr = ADDRESSES.collateral as Hex;
        debug("[collateral-withdraw] withdrawing", amount.toString());
        const hash = await walletClient.writeContract({
          address: collateralAddr,
          abi: COLLATERAL_ABI,
          functionName: "withdraw",
          account: address,
          chain: expectedChain,
          args: [amount],
          gas: 200_000n,
        });
        debug("[collateral-withdraw] tx:", hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        console.error("[collateral-withdraw] FAILED:", err);
        setError(humanizeError(err, "Withdraw failed"));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address]
  );

  return { withdraw, loading, error };
}

// ---------------------------------------------------------------------------
// Early exit hook — either party can trigger before a full audit batch
// ---------------------------------------------------------------------------

export function useEarlyExit() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const earlyExit = useCallback(
    async (genius: string, idiot: string) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      setTxHash(null);
      try {
        const auditAddr = ADDRESSES.audit as Hex;
        debug("[early-exit] triggering", genius, idiot);
        const hash = await walletClient.writeContract({
          address: auditAddr,
          abi: AUDIT_VIEM_ABI,
          functionName: "earlyExit",
          account: address,
          chain: expectedChain,
          args: [genius as Hex, idiot as Hex],
        });
        debug("[early-exit] tx:", hash);
        setTxHash(hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        console.error("[early-exit] FAILED:", err);
        setError(humanizeError(err, "Early exit failed"));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address],
  );

  return { earlyExit, loading, error, txHash };
}

// ---------------------------------------------------------------------------
// Void (cancel) a signal
// ---------------------------------------------------------------------------

export function useCancelSignal() {
  const { data: walletClient } = useWalletClient();
  const { address } = useAccount();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const cancelSignal = useCallback(
    async (signalId: bigint) => {
      if (!walletClient || !address) throw new Error("Wallet not connected");
      assertCorrectChain(walletClient);
      setLoading(true);
      setError(null);
      setTxHash(null);
      try {
        const hash = await walletClient.writeContract({
          address: ADDRESSES.signalCommitment as Hex,
          abi: SIGNAL_COMMITMENT_VIEM_ABI,
          functionName: "cancelSignal",
          account: address,
          chain: expectedChain,
          args: [signalId],
        });
        setTxHash(hash);
        await waitForTx(hash);
        return hash;
      } catch (err) {
        const msg = humanizeError(err, "Failed to cancel signal");
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [walletClient, address],
  );

  return { cancelSignal, loading, error, txHash };
}

// ---------------------------------------------------------------------------
// Fetch purchases for a signal (how much notional has been taken)
// ---------------------------------------------------------------------------

export function useSignalNotionalFilled(signalId: string | undefined) {
  const [filled, setFilled] = useState(0n);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!signalId) {
      setFilled(0n);
      return;
    }
    setLoading(true);
    try {
      const provider = getReadProvider();
      const escrow = getEscrowContract(provider);
      const val = await escrow.signalNotionalFilled(signalId);
      setFilled(BigInt(val));
    } catch {
      // Contract may not have this signal
    } finally {
      setLoading(false);
    }
  }, [signalId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { filled, loading, refresh };
}

export function useSignalPurchases(signalId: string | undefined) {
  const [purchases, setPurchases] = useState<
    { purchaseId: bigint; notional: bigint; buyer: string; outcome: number }[]
  >([]);
  const [totalNotional, setTotalNotional] = useState(0n);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!signalId) {
      setPurchases([]);
      setTotalNotional(0n);
      return;
    }

    setLoading(true);
    try {
      const provider = getReadProvider();
      const escrow = getEscrowContract(provider);
      const purchaseIds: bigint[] = await escrow.getPurchasesBySignal(signalId);

      const results = [];
      let total = 0n;
      for (const pid of purchaseIds) {
        const p = await escrow.getPurchase(pid);
        const notional = BigInt(p.notional ?? 0);
        results.push({
          purchaseId: pid,
          notional,
          buyer: String(p.idiot ?? ""),
          outcome: Number(p.outcome ?? 0),
        });
        total += notional;
      }
      setPurchases(results);
      setTotalNotional(total);
    } catch {
      // Contract may not have this signal
    } finally {
      setLoading(false);
    }
  }, [signalId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { purchases, totalNotional, loading, refresh };
}
