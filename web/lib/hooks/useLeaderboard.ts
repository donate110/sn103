"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLeaderboard,
  isSubgraphConfigured,
  type SubgraphGeniusEntry,
} from "../subgraph";
import type { GeniusLeaderboardEntry } from "../types";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isSubgraphConfigured();
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
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
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { data, loading, error, configured, refresh };
}
