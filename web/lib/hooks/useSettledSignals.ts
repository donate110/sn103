"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getEscrowContract, getSignalCommitmentContract } from "../contracts";
import { fetchGeniusSignals, type SubgraphSignal } from "../subgraph";
import { deriveMasterSeedTyped, deriveSignalKey, decrypt, encrypt, keyToBigInt } from "../crypto";
import type { SignTypedDataParams } from "../crypto";

/** Encrypted localStorage envelope format. */
interface EncryptedStorageEnvelope {
  _encrypted: true;
  ciphertext: string;
  iv: string;
}

/** Private signal data saved to localStorage during signal creation. */
export interface SavedSignalData {
  signalId: string;
  preimage: string;
  realIndex: number;
  sport: string;
  pick: string;
  minOdds?: number | null;
  minOddsAmerican?: string | null;
  slaMultiplierBps: number;
  createdAt: number;
  /** Whether the miner verified lines were live at creation time. */
  minerVerified?: boolean;
}

/** A signal ready for track record proof generation, merging private + on-chain data. */
export interface ProofReadySignal {
  signalId: string;
  preimage: string;
  realIndex: number;
  sport: string;
  pick: string;
  // Per-purchase data (a signal may have multiple purchases)
  purchases: ProofReadyPurchase[];
  status: string;
  createdAt: number;
  /** Whether the miner verified lines at creation (or implicitly at purchase). */
  minerVerified: boolean;
}

export interface ProofReadyPurchase {
  purchaseId: string;
  notional: string;
  odds: string;
  outcome: string; // "Pending" | "Favorable" | "Unfavorable" | "Void"
  slaBps: string;
}

const LEGACY_KEY = "djinn-signal-data";

function signalStorageKey(address: string): string {
  return `djinn-signal-data:${address.toLowerCase()}`;
}

/** Read saved signal data from localStorage, namespaced by wallet address. */
export function getSavedSignals(address?: string): SavedSignalData[] {
  if (typeof window === "undefined" || !address) return [];
  try {
    const key = signalStorageKey(address);
    let raw = localStorage.getItem(key);

    // Lazy migration: move legacy non-namespaced data to namespaced key
    if (!raw) {
      const legacyRaw = localStorage.getItem(LEGACY_KEY);
      if (legacyRaw) {
        localStorage.setItem(key, legacyRaw);
        localStorage.removeItem(LEGACY_KEY);
        raw = legacyRaw;
      }
    }

    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // If encrypted, return empty — caller needs async version with seed
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed._encrypted === true) return [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write saved signal data to localStorage, namespaced by wallet address. */
export function saveSavedSignals(address: string, signals: SavedSignalData[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(signalStorageKey(address), JSON.stringify(signals));
  } catch {
    console.warn("Failed to save signal data to localStorage");
  }
}

/** Async read that can decrypt encrypted localStorage data. */
export async function getSavedSignalsEncrypted(
  address: string | undefined,
  masterSeed: Uint8Array | null,
): Promise<{ signals: SavedSignalData[]; encrypted: boolean; locked: boolean }> {
  if (typeof window === "undefined" || !address) {
    return { signals: [], encrypted: false, locked: false };
  }

  const key = signalStorageKey(address);
  let raw = localStorage.getItem(key);

  // Legacy migration
  if (!raw) {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      localStorage.setItem(key, legacyRaw);
      localStorage.removeItem(LEGACY_KEY);
      raw = legacyRaw;
    }
  }

  if (!raw) return { signals: [], encrypted: false, locked: false };

  try {
    const parsed = JSON.parse(raw);

    // Encrypted envelope
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed._encrypted === true) {
      if (!masterSeed) {
        return { signals: [], encrypted: true, locked: true };
      }
      const plaintext = await decrypt(parsed.ciphertext, parsed.iv, masterSeed);
      const signals = JSON.parse(plaintext);
      return {
        signals: Array.isArray(signals) ? signals : [],
        encrypted: true,
        locked: false,
      };
    }

    // Legacy plaintext array
    return {
      signals: Array.isArray(parsed) ? parsed : [],
      encrypted: false,
      locked: false,
    };
  } catch {
    return { signals: [], encrypted: false, locked: false };
  }
}

/** Async write that encrypts data when master seed is available. */
export async function saveSavedSignalsEncrypted(
  address: string,
  signals: SavedSignalData[],
  masterSeed: Uint8Array | null,
): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    if (masterSeed) {
      const plaintext = JSON.stringify(signals);
      const { ciphertext, iv } = await encrypt(plaintext, masterSeed);
      const envelope: EncryptedStorageEnvelope = { _encrypted: true, ciphertext, iv };
      localStorage.setItem(signalStorageKey(address), JSON.stringify(envelope));
    } else {
      localStorage.setItem(signalStorageKey(address), JSON.stringify(signals));
    }
  } catch {
    console.warn("Failed to save signal data to localStorage");
  }
}

/**
 * Recover signal private data from on-chain encrypted blobs using wallet-derived keys.
 * For each signal the Genius owns, derives the AES key via EIP-712 signTypedData,
 * reads the encrypted blob from SignalCommitment, and decrypts to recover realIndex + pick.
 *
 * Uses EIP-712 (signTypedData) instead of personal_sign because ERC-4337
 * smart wallets (Coinbase Smart Wallet, etc.) don't reliably support personal_sign.
 */
export async function recoverSignalsFromChain(
  geniusAddress: string,
  signTypedDataFn: (params: SignTypedDataParams) => Promise<string>,
  signalIds: string[],
): Promise<SavedSignalData[]> {
  if (signalIds.length === 0) return [];

  const masterSeed = await deriveMasterSeedTyped(signTypedDataFn);
  const provider = getReadProvider();
  const signalCommitment = getSignalCommitmentContract(provider);
  const recovered: SavedSignalData[] = [];

  for (const id of signalIds) {
    try {
      const signal = await signalCommitment.getSignal(BigInt(id));
      const blobBytes: string = signal.encryptedBlob;
      if (!blobBytes || blobBytes === "0x" || blobBytes.length <= 2) continue;

      // Decode the blob from bytes to string
      const blobStr = new TextDecoder().decode(
        Uint8Array.from(
          blobBytes.replace(/^0x/, "").match(/.{2}/g)!.map((b: string) => parseInt(b, 16)),
        ),
      );

      const colonIdx = blobStr.indexOf(":");
      if (colonIdx < 0) continue;
      const iv = blobStr.slice(0, colonIdx);
      const ciphertext = blobStr.slice(colonIdx + 1);

      const aesKey = await deriveSignalKey(masterSeed, BigInt(id));
      const json = await decrypt(ciphertext, iv, aesKey);
      const payload = JSON.parse(json);

      recovered.push({
        signalId: id,
        preimage: keyToBigInt(aesKey).toString(),
        realIndex: payload.realIndex ?? 1,
        sport: signal.sport ?? "",
        pick: payload.pick ?? "",
        minOdds: payload.minOdds ?? null,
        minOddsAmerican: payload.minOddsAmerican ?? null,
        slaMultiplierBps: Number(signal.slaMultiplierBps ?? 0),
        createdAt: Number(signal.createdAt ?? 0),
      });
    } catch {
      // Decryption failed — signal was created with a random key (legacy) or different wallet
      continue;
    }
  }

  return recovered;
}

/**
 * Hook that merges localStorage private signal data with on-chain/subgraph
 * purchase data to produce proof-ready signal records.
 */
export function useSettledSignals(geniusAddress: string | undefined) {
  const [signals, setSignals] = useState<ProofReadySignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!geniusAddress) {
      setSignals([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Step 1: Read private data from localStorage (namespaced by wallet)
      const saved = getSavedSignals(geniusAddress);
      if (saved.length === 0) {
        setSignals([]);
        setLoading(false);
        return;
      }

      // Step 2: Query subgraph for signal status + purchases
      const subgraphSignals = await fetchGeniusSignals(geniusAddress);
      const subgraphMap = new Map<string, SubgraphSignal>();
      for (const sig of subgraphSignals) {
        subgraphMap.set(sig.id, sig);
      }

      // Step 3: For purchases with settled outcomes, try to get odds from contract
      const escrow = getEscrowContract(getReadProvider());

      const results: ProofReadySignal[] = [];

      for (const s of saved) {
        const subSig = subgraphMap.get(s.signalId);

        const purchases: ProofReadyPurchase[] = [];

        if (subSig?.purchases) {
          for (const p of subSig.purchases) {
            if (p.outcome === "Pending") continue;

            let odds = "0";
            // Try to fetch odds from on-chain Purchase struct
            if (p.onChainPurchaseId) {
              try {
                const purchase = await escrow.getPurchase(p.onChainPurchaseId);
                odds = purchase.odds?.toString() ?? "0";
              } catch {
                // Contract query failed, odds will be 0
              }
            }

            purchases.push({
              purchaseId: p.onChainPurchaseId,
              notional: p.notional,
              odds,
              outcome: p.outcome,
              slaBps: subSig.slaMultiplierBps,
            });
          }
        }

        // A signal is considered verified if:
        // 1. Miner verified at creation time, OR
        // 2. It has purchases (purchase flow requires miner MPC check)
        const verified = s.minerVerified === true || purchases.length > 0;

        results.push({
          signalId: s.signalId,
          preimage: s.preimage,
          realIndex: s.realIndex,
          sport: s.sport,
          pick: s.pick,
          purchases,
          status: subSig?.status ?? "Unknown",
          createdAt: s.createdAt,
          minerVerified: verified,
        });
      }

      if (!cancelledRef.current) {
        setSignals(results);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load signal data");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [geniusAddress]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { signals, loading, error, refresh };
}
