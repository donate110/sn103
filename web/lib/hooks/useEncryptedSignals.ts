"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import {
  isMasterSeedCached,
  getCachedMasterSeed,
  deriveMasterSeedTyped,
} from "../crypto";
import {
  getSavedSignalsEncrypted,
  saveSavedSignalsEncrypted,
  type SavedSignalData,
} from "./useSettledSignals";

interface UseEncryptedSignalsResult {
  signals: SavedSignalData[];
  loading: boolean;
  /** Data exists in localStorage but is encrypted and seed is not cached. */
  locked: boolean;
  /** Master seed is in memory (no wallet popup needed). */
  seedReady: boolean;
  /** Trigger wallet signature to derive master seed and decrypt data. */
  unlock: () => Promise<void>;
  /** Save signals (encrypted if seed available). */
  save: (signals: SavedSignalData[]) => Promise<void>;
  /** Re-read from localStorage. */
  refresh: () => Promise<void>;
}

export function useEncryptedSignals(): UseEncryptedSignalsResult {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [signals, setSignals] = useState<SavedSignalData[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [seedReady, setSeedReady] = useState(() => isMasterSeedCached());

  const load = useCallback(async () => {
    if (!address) {
      setSignals([]);
      setLoading(false);
      setLocked(false);
      return;
    }
    setLoading(true);
    const seed = getCachedMasterSeed();
    const result = await getSavedSignalsEncrypted(address, seed);
    setSignals(result.signals);
    setLocked(result.locked);
    setSeedReady(isMasterSeedCached());
    setLoading(false);
  }, [address]);

  useEffect(() => {
    load();
  }, [load]);

  const unlock = useCallback(async () => {
    if (!walletClient || !address) return;
    const seed = await deriveMasterSeedTyped(
      (params) => walletClient.signTypedData(params),
    );
    setSeedReady(true);
    const result = await getSavedSignalsEncrypted(address, seed);
    setSignals(result.signals);
    setLocked(false);
  }, [walletClient, address]);

  const save = useCallback(async (newSignals: SavedSignalData[]) => {
    if (!address) return;
    const seed = getCachedMasterSeed();
    await saveSavedSignalsEncrypted(address, newSignals, seed);
    setSignals(newSignals);
  }, [address]);

  return { signals, loading, locked, seedReady, unlock, save, refresh: load };
}
