"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReadProvider } from "../hooks";
import { getAuditsByGenius, getAuditsByIdiot } from "../events";
import type { AuditEvent } from "../events";

/** Polling interval for audit history: 60 seconds */
const AUDIT_POLL_MS = 60_000;

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

  // Initial fetch + silent polling (pauses on hidden tab)
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current && !document.hidden) refresh(true);
    }, AUDIT_POLL_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
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

  // Initial fetch + silent polling
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh(true);
    }, AUDIT_POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [refresh]);

  return { audits, loading, error, refresh: () => refresh() };
}
