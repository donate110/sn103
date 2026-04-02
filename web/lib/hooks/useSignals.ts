"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getActiveSignals, getSignalsByGenius, invalidateSignalCache } from "../events";
import type { SignalEvent } from "../events";

/** Default polling interval: 10 seconds */
const POLL_INTERVAL_MS = 10_000;

export function useActiveSignals(sport?: string, geniusAddress?: string, includeAll: boolean = false) {
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const hasFetchedRef = useRef(false);

  const refresh = useCallback(async (silent = false, bustCache = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      let result: SignalEvent[];

      // Use server-side API when possible (faster, cached, no client-side RPC)
      if (geniusAddress) {
        try {
          const params = new URLSearchParams({ address: geniusAddress, limit: "100" });
          if (includeAll) params.set("include_all", "1");
          if (bustCache) params.set("bust", "1");
          const res = await fetch(`/api/genius/signals?${params}`);
          if (res.ok) {
            const data = await res.json();
            result = (data.signals ?? []).map((s: Record<string, unknown>) => ({
              signalId: String(s.signal_id ?? s.signalId ?? ""),
              genius: String(s.genius ?? ""),
              sport: String(s.sport ?? ""),
              maxPriceBps: BigInt(Number(s.fee_bps ?? s.maxPriceBps ?? 0)),
              slaMultiplierBps: BigInt(Number(s.sla_multiplier_bps ?? s.slaMultiplierBps ?? 0)),
              maxNotional: BigInt(s.max_notional as string || String(s.maxNotional ?? "0")),
              minNotional: BigInt(s.min_notional as string || String(s.minNotional ?? "0")),
              expiresAt: BigInt(Number(s.expires_at_unix ?? s.expiresAt ?? 0)),
              blockNumber: 0,
            }));
          } else {
            // Fallback to direct RPC if API fails
            const provider = getReadProvider();
            result = await getSignalsByGenius(provider, geniusAddress, undefined, includeAll);
          }
        } catch {
          // Fallback to direct RPC
          const provider = getReadProvider();
          result = await getSignalsByGenius(provider, geniusAddress, undefined, includeAll);
        }
      } else {
        // Browse all signals via API
        try {
          const params = new URLSearchParams({ limit: "100" });
          if (sport) params.set("sport", sport);
          if (bustCache) params.set("bust", "1");
          const res = await fetch(`/api/idiot/browse?${params}`);
          if (res.ok) {
            const data = await res.json();
            result = (data.signals ?? []).map((s: Record<string, unknown>) => ({
              signalId: String(s.signal_id ?? ""),
              genius: String(s.genius ?? ""),
              sport: String(s.sport ?? ""),
              maxPriceBps: BigInt(Number(s.fee_bps ?? 0)),
              slaMultiplierBps: BigInt(Number(s.sla_multiplier_bps ?? 0)),
              maxNotional: BigInt(s.max_notional as string || "0"),
              minNotional: BigInt(s.min_notional as string || "0"),
              expiresAt: BigInt(Number(s.expires_at_unix ?? 0)),
              blockNumber: 0,
            }));
          } else {
            const provider = getReadProvider();
            result = await getActiveSignals(provider);
          }
        } catch {
          const provider = getReadProvider();
          result = await getActiveSignals(provider);
        }
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

  /** Force-refresh: invalidates client + server cache for immediate on-chain data. */
  const forceRefresh = useCallback(async () => {
    invalidateSignalCache(geniusAddress);
    return refresh(false, true);
  }, [geniusAddress, refresh]);

  // Initial fetch + polling (polls are silent - no loading skeleton flash)
  useEffect(() => {
    cancelledRef.current = false;
    hasFetchedRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current && !document.hidden) refresh(true);
    }, POLL_INTERVAL_MS);
    const onVisible = () => { if (!document.hidden) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { signals, loading, error, refresh: () => refresh(), forceRefresh };
}
