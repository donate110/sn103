"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getPurchasesByBuyer } from "../events";
import type { PurchaseEvent } from "../events";

/** Polling interval: 30 seconds (staggered +10s from signals) */
const PURCHASE_POLL_MS = 30_000;
const INITIAL_DELAY_MS = 10_000;

export function usePurchaseHistory(buyerAddress?: string) {
  const [purchases, setPurchases] = useState<PurchaseEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!buyerAddress) {
      setPurchases([]);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const provider = getReadProvider();
      const result = await getPurchasesByBuyer(provider, buyerAddress);
      if (!cancelledRef.current) {
        setPurchases(result);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch purchases");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [buyerAddress]);

  // Initial fetch + polling (pauses on hidden tab, staggered start)
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    // Stagger polling start so hooks don't all fire at the same instant
    const startTimer = setTimeout(() => {
      if (cancelledRef.current) return;
      intervalRef.current = setInterval(() => {
        if (!cancelledRef.current && !document.hidden) refresh(true);
      }, PURCHASE_POLL_MS);
    }, INITIAL_DELAY_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearTimeout(startTimer);
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { purchases, loading, error, refresh };
}
