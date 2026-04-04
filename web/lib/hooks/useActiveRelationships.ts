"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { getReadProvider } from "../hooks";
import { getAuditsByGenius, getAuditsByIdiot, resolveDeployBlock, queryFilterChunked } from "../events";
import {
  ADDRESSES,
  ACCOUNT_ABI,
  getAccountContract,
  detectContractVersion,
  type ContractVersion,
} from "../contracts";

/** Polling interval for relationships: 60 seconds */
const RELATIONSHIPS_POLL_MS = 60_000;

export interface ActiveRelationship {
  genius: string;
  idiot: string;
  /** v1: signals in current cycle. v2: total purchases in the queue. */
  signalCount: number;
  qualityScore: number;
  /** v1: current cycle number. v2: audit batch count. */
  currentCycle: number;
  /** v1: signalCount >= 10. v2: resolvedCount - auditedCount >= 10. */
  isAuditReady: boolean;
  /** v2-only fields, present when contract is v2 */
  resolvedCount?: number;
  auditedCount?: number;
  /** Which contract version populated this data */
  contractVersion: ContractVersion;
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

  const refresh = useCallback(async (silent = false) => {
    if (!address || !ADDRESSES.account) {
      setRelationships([]);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);

    try {
      const provider = getReadProvider();
      const counterparties = new Set<string>();

      // Source 1: PurchaseRecorded events for unique counterparties
      // Source 2: Audit history for past counterparties
      // Run both in parallel
      const [, ] = await Promise.allSettled([
        (async () => {
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
        })(),
        (async () => {
          const audits = role === "genius"
            ? await getAuditsByGenius(provider, address)
            : await getAuditsByIdiot(provider, address);
          for (const a of audits) {
            const other = role === "genius" ? a.idiot : a.genius;
            counterparties.add(other.toLowerCase());
          }
        })(),
      ]);

      if (cancelledRef.current) return;

      if (counterparties.size === 0) {
        setRelationships([]);
        setLoading(false);
        return;
      }

      // Detect contract version (cached after first call)
      const version = await detectContractVersion(provider);

      // Query current state for counterparties with controlled concurrency
      const accountContract = getAccountContract(provider);
      const cpArray = Array.from(counterparties).slice(0, 50); // Cap at 50 to avoid RPC flood
      const BATCH = 10;
      const results: PromiseSettledResult<ActiveRelationship | null>[] = [];
      for (let i = 0; i < cpArray.length; i += BATCH) {
        const batch = cpArray.slice(i, i + BATCH);
        const batchResults = await Promise.allSettled(
          batch.map(async (cp) => {
            const genius = role === "genius" ? address : cp;
            const idiot = role === "genius" ? cp : address;

            if (version === 2) {
              // v2: queue-based
              const qs = await accountContract.getQueueState(genius, idiot);
              const totalPurchases = Number(qs.totalPurchases);
              if (totalPurchases > 0) {
                const resolved = Number(qs.resolvedCount);
                const audited = Number(qs.auditedCount);
                const batchCount = Number(qs.auditBatchCount);
                return {
                  genius,
                  idiot,
                  signalCount: totalPurchases,
                  qualityScore: 0, // v2 doesn't store running QS on pair
                  currentCycle: batchCount,
                  isAuditReady: (resolved - audited) >= 10,
                  resolvedCount: resolved,
                  auditedCount: audited,
                  contractVersion: 2,
                } as ActiveRelationship;
              }
              return null;
            }

            // v1: cycle-based
            const state = await accountContract.getAccountState(genius, idiot);
            const signalCount = Number(state.signalCount);
            if (signalCount > 0) {
              return {
                genius,
                idiot,
                signalCount,
                qualityScore: Number(state.outcomeBalance),
                currentCycle: Number(state.currentCycle),
                isAuditReady: signalCount >= 10,
                contractVersion: 1,
              } as ActiveRelationship;
            }
            return null;
          }),
        );
        results.push(...batchResults);
        if (cancelledRef.current) break;
      }

      if (!cancelledRef.current) {
        const active = results
          .filter((r): r is PromiseFulfilledResult<ActiveRelationship | null> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((r): r is ActiveRelationship => r !== null)
          .sort((a, b) => b.signalCount - a.signalCount);
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
    const interval = setInterval(() => {
      if (!cancelledRef.current && !document.hidden) refresh(true);
    }, RELATIONSHIPS_POLL_MS);
    const onVisible = () => { if (!document.hidden && !cancelledRef.current) refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { relationships, loading, error, refresh };
}
