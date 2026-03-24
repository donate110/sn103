"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getPurchasesByBuyer } from "../events";
import type { PurchaseEvent } from "../events";

/** Polling interval: 30 seconds */
const PURCHASE_POLL_MS = 30_000;

export function usePurchaseHistory(buyerAddress?: string) {
  const [purchases, setPurchases] = useState<PurchaseEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!buyerAddress) {
      setPurchases([]);
      return;
    }
    setLoading(true);
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

  // Initial fetch + polling
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh();
    }, PURCHASE_POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [refresh]);

  // Refresh on window focus
  useEffect(() => {
    const onFocus = () => {
      if (!cancelledRef.current) refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { purchases, loading, error, refresh };
}
