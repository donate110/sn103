"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { getReadProvider } from "../hooks";
import { getAuditsByGenius, getAuditsByIdiot, resolveDeployBlock, queryFilterChunked } from "../events";
import {
  ADDRESSES,
  ACCOUNT_ABI,
  getAccountContract,
} from "../contracts";

export interface ActiveRelationship {
  genius: string;
  idiot: string;
  signalCount: number;
  qualityScore: number;
  currentCycle: number;
  isAuditReady: boolean;
}

/**
 * Discovers all active relationships for an address (as genius or idiot).
 * "Active" means signalCount > 0 in the current cycle.
 *
 * Discovery sources:
 * 1. PurchaseRecorded events from Account contract (genius or idiot indexed)
 * 2. AuditSettled / EarlyExitSettled events (for past counterparties)
 *
 * For each unique counterparty, queries the current Account state.
 */
export function useActiveRelationships(
  address?: string,
  role: "genius" | "idiot" = "genius",
) {
  const [relationships, setRelationships] = useState<ActiveRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address || !ADDRESSES.account) {
      setRelationships([]);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const provider = getReadProvider();
      const counterparties = new Set<string>();

      // Source 1: PurchaseRecorded events for unique counterparties
      try {
        const contract = new ethers.Contract(ADDRESSES.account, ACCOUNT_ABI, provider);
        const fromBlock = await resolveDeployBlock(provider);
        const filter = role === "genius"
          ? contract.filters.PurchaseRecorded(address)
          : contract.filters.PurchaseRecorded(null, address);
        const events = await queryFilterChunked(contract, filter, fromBlock);
        for (const event of events) {
          const log = event as ethers.EventLog;
          if (!log.args) continue;
          const other = role === "genius" ? log.args[1] : log.args[0];
          if (other && typeof other === "string") counterparties.add(other.toLowerCase());
        }
      } catch {
        // PurchaseRecorded scanning failed — fall through to audit history
      }

      // Source 2: Audit history for past counterparties (may have new cycles)
      try {
        const audits = role === "genius"
          ? await getAuditsByGenius(provider, address)
          : await getAuditsByIdiot(provider, address);
        for (const a of audits) {
          const other = role === "genius" ? a.idiot : a.genius;
          counterparties.add(other.toLowerCase());
        }
      } catch {
        // Audit history scanning failed
      }

      if (cancelledRef.current) return;

      if (counterparties.size === 0) {
        setRelationships([]);
        setLoading(false);
        return;
      }

      // Query current state for each counterparty
      const accountContract = getAccountContract(provider);
      const active: ActiveRelationship[] = [];

      for (const cp of counterparties) {
        if (cancelledRef.current) return;
        try {
          const genius = role === "genius" ? address : cp;
          const idiot = role === "genius" ? cp : address;
          const state = await accountContract.getAccountState(genius, idiot);
          const signalCount = Number(state.signalCount);
          if (signalCount > 0) {
            active.push({
              genius,
              idiot,
              signalCount,
              qualityScore: Number(state.qualityScore),
              currentCycle: Number(state.currentCycle),
              isAuditReady: signalCount >= 10,
            });
          }
        } catch {
          // Skip this pair if query fails
        }
      }

      if (!cancelledRef.current) {
        // Sort by signal count descending (closest to audit first)
        active.sort((a, b) => b.signalCount - a.signalCount);
        setRelationships(active);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load relationships");
      }
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, [address, role]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  return { relationships, loading, error, refresh };
}
