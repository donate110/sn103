"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getAuditsByGenius, getAuditsByIdiot } from "../events";
import type { AuditEvent } from "../events";

/** Polling interval for audit history: 30 seconds (staggered +20s from signals) */
const AUDIT_POLL_MS = 30_000;
const INITIAL_DELAY_MS = 20_000;

export function useAuditHistory(geniusAddress?: string) {
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!geniusAddress) {
      setAudits([]);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const provider = getReadProvider();
      const result = await getAuditsByGenius(provider, geniusAddress);
      if (!cancelledRef.current) {
        setAudits(result);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch audit history");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [geniusAddress]);

  // Initial fetch + silent polling (pauses on hidden tab, staggered start)
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    let interval: ReturnType<typeof setInterval>;
    const startTimer = setTimeout(() => {
      if (cancelledRef.current) return;
      interval = setInterval(() => {
        if (!cancelledRef.current && !document.hidden) refresh(true);
      }, AUDIT_POLL_MS);
    }, INITIAL_DELAY_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearTimeout(startTimer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const aggregateQualityScore = useMemo(
    () => audits.reduce((sum, a) => sum + a.qualityScore, 0n),
    [audits],
  );

  return { audits, loading, error, refresh: () => refresh(), aggregateQualityScore };
}

export function useIdiotAuditHistory(idiotAddress?: string) {
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!idiotAddress) {
      setAudits([]);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const provider = getReadProvider();
      const result = await getAuditsByIdiot(provider, idiotAddress);
      if (!cancelledRef.current) {
        setAudits(result);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch audit history");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [idiotAddress]);

  // Initial fetch + silent polling (pauses on hidden tab, staggered start)
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    let interval: ReturnType<typeof setInterval>;
    const startTimer = setTimeout(() => {
      if (cancelledRef.current) return;
      interval = setInterval(() => {
        if (!cancelledRef.current && !document.hidden) refresh(true);
      }, AUDIT_POLL_MS);
    }, INITIAL_DELAY_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearTimeout(startTimer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { audits, loading, error, refresh: () => refresh() };
}
