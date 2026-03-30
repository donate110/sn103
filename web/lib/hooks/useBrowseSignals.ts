"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SignalEvent } from "../events";

/** Polling interval for the browse page (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Fetch active signals from the server-side /api/idiot/browse endpoint.
 * This is much faster than client-side event scanning because the server
 * has a stable RPC connection and doesn't get rate-limited by public RPCs.
 */
export function useBrowseSignals(sport?: string) {
  const [signals, setSignals] = useState<SignalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sport) params.set("sport", sport);
      params.set("limit", "100");

      const res = await fetch(`/api/idiot/browse?${params}`);
      if (!res.ok) {
        throw new Error(`Browse API returned ${res.status}`);
      }
      const data = await res.json();

      if (cancelledRef.current) return;

      const mapped: SignalEvent[] = (data.signals ?? []).map((s: Record<string, unknown>) => ({
        signalId: String(s.signal_id),
        genius: String(s.genius),
        sport: String(s.sport),
        maxPriceBps: BigInt(s.fee_bps as number),
        slaMultiplierBps: BigInt(s.sla_multiplier_bps as number),
        maxNotional: BigInt(s.max_notional as string || "0"),
        minNotional: BigInt(s.min_notional as string || "0"),
        expiresAt: BigInt(s.expires_at_unix as number || 0),
        blockNumber: 0,
      }));

      setSignals(mapped);
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch signals");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [sport]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh(true);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [refresh]);

  return { signals, loading, error, refresh: () => refresh() };
}
