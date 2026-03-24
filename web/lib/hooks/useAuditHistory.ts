"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

  const refresh = useCallback(async () => {
    if (!geniusAddress) {
      setAudits([]);
      return;
    }
    setLoading(true);
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

  // Initial fetch + polling
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh();
    }, AUDIT_POLL_MS);
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

  const aggregateQualityScore = audits.reduce(
    (sum, a) => sum + a.qualityScore,
    0n,
  );

  return { audits, loading, error, refresh, aggregateQualityScore };
}

export function useIdiotAuditHistory(idiotAddress?: string) {
  const [audits, setAudits] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!idiotAddress) {
      setAudits([]);
      return;
    }
    setLoading(true);
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

  // Initial fetch + polling
  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current) refresh();
    }, AUDIT_POLL_MS);
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

  return { audits, loading, error, refresh };
}
