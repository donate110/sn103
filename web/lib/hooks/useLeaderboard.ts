"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLeaderboard,
  isSubgraphConfigured,
  type SubgraphGeniusEntry,
} from "../subgraph";
import type { GeniusLeaderboardEntry } from "../types";

/** Polling interval for leaderboard: 60 seconds (lightweight subgraph query) */
const LEADERBOARD_POLL_MS = 60_000;

function toLeaderboardEntry(g: SubgraphGeniusEntry): GeniusLeaderboardEntry {
  const totalGain = Number(g.aggregateQualityScore) / 1e6; // USDC decimals
  const totalVolume = Number(g.totalVolume) / 1e6; // USDC decimals
  const roi = totalVolume > 0 ? (totalGain / totalVolume) * 100 : 0;

  return {
    address: g.id,
    qualityScore: totalGain,
    totalSignals: Number(g.totalSignals),
    auditCount: Number(g.totalAudits),
    roi,
    proofCount: 0,
    favCount: Number(g.totalFavorable || 0),
    unfavCount: Number(g.totalUnfavorable || 0),
    voidCount: Number(g.totalVoid || 0),
  };
}

export function useLeaderboard() {
  const [data, setData] = useState<GeniusLeaderboardEntry[]>([]);
  const configured = isSubgraphConfigured();
  const [loading, setLoading] = useState(configured);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    if (!configured) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const entries = await fetchLeaderboard(100);
      if (!cancelledRef.current) {
        setData(entries.map(toLeaderboardEntry));
      }
    } catch (err) {
      if (!cancelledRef.current) {
        const msg =
          err instanceof Error ? err.message : "Failed to fetch leaderboard";
        setError(msg);
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [configured]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    const interval = setInterval(() => {
      if (!cancelledRef.current && !document.hidden) refresh(true);
    }, LEADERBOARD_POLL_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { data, loading, error, configured, refresh };
}
