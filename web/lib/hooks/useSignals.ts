"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getActiveSignals, getSignalsByGenius, invalidateSignalCache } from "../events";
import type { SignalEvent } from "../events";

/** Default polling interval: 30 seconds */
const POLL_INTERVAL_MS = 30_000;

export function useActiveSignals(sport?: string, geniusAddress?: string, includeAll: boolean = false) {
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const hasFetchedRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const provider = getReadProvider();
      let result: SignalEvent[];
      if (geniusAddress) {
        result = await getSignalsByGenius(provider, geniusAddress, undefined, includeAll);
      } else {
        result = await getActiveSignals(provider);
      }

      if (sport) {
        result = result.filter((s) => s.sport === sport);
      }

      if (!cancelledRef.current) {
        setSignals(result);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch signals");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [sport, geniusAddress, includeAll]);

  /** Force-refresh: invalidates cache first so we get fresh on-chain data. */
  const forceRefresh = useCallback(async () => {
    invalidateSignalCache(geniusAddress);
    return refresh();
  }, [geniusAddress, refresh]);

  // Initial fetch + polling (polls are silent - no loading skeleton flash)
  useEffect(() => {
    cancelledRef.current = false;
    hasFetchedRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh(true);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [refresh]);

  return { signals, loading, error, refresh: () => refresh(), forceRefresh };
}
