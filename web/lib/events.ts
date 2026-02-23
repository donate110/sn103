/**
 * On-chain event queries for signal discovery, purchase history, and audit history.
 *
 * Uses ethers.js event queries (no subgraph) to index contract events.
 * Queries are chunked to avoid RPC provider rate limits on large block ranges.
 * An in-memory EventCache avoids re-scanning historical blocks on repeat calls.
 */

import { ethers } from "ethers";
import {
  SIGNAL_COMMITMENT_ABI,
  ESCROW_ABI,
  AUDIT_ABI,
  ADDRESSES,
} from "./contracts";

/** Max blocks per queryFilter call to avoid RPC rate limits. */
const BLOCK_CHUNK_SIZE = 9_999;

/** Block number when contracts were first deployed. Avoids scanning from genesis. */
const RAW_DEPLOY_BLOCK = Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "0");

/**
 * If DEPLOY_BLOCK is 0 (env var not set), fall back to a recent block
 * to avoid scanning millions of blocks and hanging forever.
 * 500,000 blocks ~ 6 days on Base (2s block time).
 */
const FALLBACK_LOOKBACK = 500_000;
let _resolvedDeployBlock: number | null = null;

export async function resolveDeployBlock(provider: ethers.Provider): Promise<number> {
  if (RAW_DEPLOY_BLOCK > 0) return RAW_DEPLOY_BLOCK;
  if (_resolvedDeployBlock !== null) return _resolvedDeployBlock;
  try {
    const current = await provider.getBlockNumber();
    _resolvedDeployBlock = Math.max(0, current - FALLBACK_LOOKBACK);
  } catch {
    _resolvedDeployBlock = 0;
  }
  return _resolvedDeployBlock;
}

// Keep a synchronous alias for call sites that already have the value
const DEPLOY_BLOCK = RAW_DEPLOY_BLOCK;

/** Cache TTL in milliseconds (30 seconds). */
const CACHE_TTL_MS = 30_000;

/** Maximum number of cache keys before evicting oldest entry. */
const MAX_CACHE_KEYS = 100;

/** Maximum events per cache entry before pruning oldest. */
const MAX_EVENTS_PER_KEY = 5_000;

// ---------------------------------------------------------------------------
// Event cache — avoids re-scanning historical blocks
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  events: T[];
  lastBlock: number;
  updatedAt: number;
}

class EventCache<T extends { blockNumber: number }> {
  private cache = new Map<string, CacheEntry<T>>();

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.updatedAt > CACHE_TTL_MS) {
      // Stale — return it for the lastBlock but mark for incremental refresh
      return entry;
    }
    return entry;
  }

  set(key: string, events: T[], lastBlock: number): void {
    // Evict oldest cache key if at capacity
    if (!this.cache.has(key) && this.cache.size >= MAX_CACHE_KEYS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.updatedAt < oldestTime) {
          oldestTime = v.updatedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    // Cap events per key to prevent unbounded growth
    const capped = events.length > MAX_EVENTS_PER_KEY
      ? events.slice(-MAX_EVENTS_PER_KEY)
      : events;
    this.cache.set(key, { events: capped, lastBlock, updatedAt: Date.now() });
  }

  /** Merge new events into existing cache, deduplicating by blockNumber. */
  merge(key: string, newEvents: T[], lastBlock: number): T[] {
    const existing = this.cache.get(key);
    if (!existing) {
      this.set(key, newEvents, lastBlock);
      return newEvents;
    }
    // Only include events from blocks not already in the cache
    const cutoff = existing.lastBlock;
    const deduped = newEvents.filter((e) => e.blockNumber > cutoff);
    const merged = [...existing.events, ...deduped];
    this.set(key, merged, lastBlock);
    return merged;
  }

  isFresh(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    return Date.now() - entry.updatedAt < CACHE_TTL_MS;
  }

  clear(): void {
    this.cache.clear();
  }
}

const signalCache = new EventCache<SignalEvent>();
const purchaseCache = new EventCache<PurchaseEvent>();
const auditCache = new EventCache<AuditEvent>();

/** Reset all caches. Exported for test isolation. */
export function resetEventCaches(): void {
  signalCache.clear();
  purchaseCache.clear();
  auditCache.clear();
}

// ---------------------------------------------------------------------------
// Chunked query helper
// ---------------------------------------------------------------------------

/**
 * Query contract events in chunks to handle large block ranges safely.
 * Falls back to querying the full range if provider doesn't support getBlockNumber.
 */
export async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
): Promise<(ethers.EventLog | ethers.Log)[]> {
  let toBlock: number;
  try {
    toBlock = await contract.runner!.provider!.getBlockNumber();
  } catch {
    // Fallback: query without chunking (works for local dev)
    return contract.queryFilter(filter, fromBlock);
  }

  if (toBlock <= fromBlock) {
    return [];
  }

  if (toBlock - fromBlock <= BLOCK_CHUNK_SIZE) {
    return contract.queryFilter(filter, fromBlock, toBlock);
  }

  const allEvents: (ethers.EventLog | ethers.Log)[] = [];
  for (let start = fromBlock; start <= toBlock; start += BLOCK_CHUNK_SIZE) {
    const end = Math.min(start + BLOCK_CHUNK_SIZE - 1, toBlock);
    const chunk = await contract.queryFilter(filter, start, end);
    allEvents.push(...chunk);
  }
  return allEvents;
}

// ---------------------------------------------------------------------------
// Signal events
// ---------------------------------------------------------------------------

export interface SignalEvent {
  signalId: string;
  genius: string;
  sport: string;
  maxPriceBps: bigint;
  slaMultiplierBps: bigint;
  maxNotional: bigint;
  minNotional: bigint;
  expiresAt: bigint;
  blockNumber: number;
}

function parseSignalEvents(
  events: (ethers.EventLog | ethers.Log)[],
): SignalEvent[] {
  const signals: SignalEvent[] = [];
  for (const event of events) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    signals.push({
      signalId: log.args.signalId.toString(),
      genius: log.args.genius as string,
      sport: log.args.sport as string,
      maxPriceBps: BigInt(log.args.maxPriceBps),
      slaMultiplierBps: BigInt(log.args.slaMultiplierBps),
      maxNotional: BigInt(log.args.maxNotional),
      minNotional: 0n, // Not in event; enriched from contract in getActiveSignals
      expiresAt: BigInt(log.args.expiresAt),
      blockNumber: log.blockNumber,
    });
  }
  return signals;
}

export async function getActiveSignals(
  provider: ethers.Provider,
  fromBlock?: number,
): Promise<SignalEvent[]> {
  const effectiveFrom = fromBlock ?? await resolveDeployBlock(provider);
  const cacheKey = `signals:active`;
  const cached = signalCache.get(cacheKey);

  const contract = new ethers.Contract(
    ADDRESSES.signalCommitment,
    SIGNAL_COMMITMENT_ABI,
    provider,
  );
  const filter = contract.filters.SignalCommitted();

  // If cache is fresh, filter out expired and return
  if (cached && signalCache.isFresh(cacheKey)) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return cached.events.filter((s) => s.expiresAt > now);
  }

  // Incremental: start from last cached block + 1
  const startBlock = cached ? cached.lastBlock + 1 : effectiveFrom;
  const events = await queryFilterChunked(contract, filter, startBlock);
  const parsed = parseSignalEvents(events);

  const all = cached ? signalCache.merge(cacheKey, parsed, getMaxBlock(parsed, cached.lastBlock)) : parsed;
  if (!cached) {
    signalCache.set(cacheKey, all, getMaxBlock(parsed, effectiveFrom));
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const notExpired = all.filter((s) => s.expiresAt > now);

  // Check on-chain status and fetch minNotional (for exclusive badge)
  const enriched = await Promise.all(
    notExpired.map(async (s) => {
      const id = BigInt(s.signalId);
      const [active, signalData] = await Promise.all([
        contract.isActive(id).catch(() => false),
        contract.getSignal(id).catch(() => null),
      ]);
      if (!active) return null;
      if (signalData && signalData.minNotional != null) {
        s.minNotional = BigInt(signalData.minNotional);
      }
      return s;
    }),
  );
  return enriched.filter((s): s is SignalEvent => s !== null);
}

export async function getSignalsByGenius(
  provider: ethers.Provider,
  geniusAddress: string,
  fromBlock?: number,
  /** When true, returns all signals including expired/settled ones. */
  includeAll: boolean = false,
): Promise<SignalEvent[]> {
  const effectiveFrom = fromBlock ?? await resolveDeployBlock(provider);
  const cacheKey = `signals:genius:${geniusAddress.toLowerCase()}`;
  const cached = signalCache.get(cacheKey);

  const contract = new ethers.Contract(
    ADDRESSES.signalCommitment,
    SIGNAL_COMMITMENT_ABI,
    provider,
  );
  const filter = contract.filters.SignalCommitted(null, geniusAddress);

  if (cached && signalCache.isFresh(cacheKey)) {
    if (includeAll) return cached.events;
    const now = BigInt(Math.floor(Date.now() / 1000));
    return cached.events.filter((s) => s.expiresAt > now);
  }

  const startBlock = cached ? cached.lastBlock + 1 : effectiveFrom;
  const events = await queryFilterChunked(contract, filter, startBlock);
  const parsed = parseSignalEvents(events);

  const all = cached ? signalCache.merge(cacheKey, parsed, getMaxBlock(parsed, cached.lastBlock)) : parsed;
  if (!cached) {
    signalCache.set(cacheKey, all, getMaxBlock(parsed, effectiveFrom));
  }

  if (includeAll) return all;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const notExpired = all.filter((s) => s.expiresAt > now);

  // Check on-chain status and fetch minNotional (for exclusive badge)
  const enriched = await Promise.all(
    notExpired.map(async (s) => {
      const id = BigInt(s.signalId);
      const [active, signalData] = await Promise.all([
        contract.isActive(id).catch(() => false),
        contract.getSignal(id).catch(() => null),
      ]);
      if (!active) return null;
      if (signalData && signalData.minNotional != null) {
        s.minNotional = BigInt(signalData.minNotional);
      }
      return s;
    }),
  );
  return enriched.filter((s): s is SignalEvent => s !== null);
}

// ---------------------------------------------------------------------------
// Purchase history
// ---------------------------------------------------------------------------

export interface PurchaseEvent {
  purchaseId: string;
  signalId: string;
  buyer: string;
  notional: bigint;
  feePaid: bigint;
  creditUsed: bigint;
  usdcPaid: bigint;
  blockNumber: number;
}

export async function getPurchasesByBuyer(
  provider: ethers.Provider,
  buyerAddress: string,
  fromBlock?: number,
): Promise<PurchaseEvent[]> {
  const effectiveFrom = fromBlock ?? await resolveDeployBlock(provider);
  const cacheKey = `purchases:buyer:${buyerAddress.toLowerCase()}`;
  const cached = purchaseCache.get(cacheKey);

  if (cached && purchaseCache.isFresh(cacheKey)) {
    return cached.events;
  }

  const contract = new ethers.Contract(
    ADDRESSES.escrow,
    ESCROW_ABI,
    provider,
  );
  const filter = contract.filters.SignalPurchased(null, buyerAddress);

  const startBlock = cached ? cached.lastBlock + 1 : effectiveFrom;
  const events = await queryFilterChunked(contract, filter, startBlock);

  const purchases: PurchaseEvent[] = [];
  for (const event of events) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    purchases.push({
      purchaseId: log.args.purchaseId.toString(),
      signalId: log.args.signalId.toString(),
      buyer: log.args.buyer as string,
      notional: BigInt(log.args.notional),
      feePaid: BigInt(log.args.feePaid),
      creditUsed: BigInt(log.args.creditUsed),
      usdcPaid: BigInt(log.args.usdcPaid),
      blockNumber: log.blockNumber,
    });
  }

  const all = cached
    ? purchaseCache.merge(cacheKey, purchases, getMaxBlock(purchases, cached.lastBlock))
    : purchases;
  if (!cached) {
    purchaseCache.set(cacheKey, all, getMaxBlock(purchases, effectiveFrom));
  }

  return all;
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

export interface AuditEvent {
  genius: string;
  idiot: string;
  cycle: bigint;
  qualityScore: bigint;
  trancheA: bigint;
  trancheB: bigint;
  protocolFee: bigint;
  isEarlyExit: boolean;
  blockNumber: number;
}

export async function getAuditsByGenius(
  provider: ethers.Provider,
  geniusAddress: string,
  fromBlock?: number,
): Promise<AuditEvent[]> {
  const effectiveFrom = fromBlock ?? await resolveDeployBlock(provider);
  const cacheKey = `audits:genius:${geniusAddress.toLowerCase()}`;
  const cached = auditCache.get(cacheKey);

  if (cached && auditCache.isFresh(cacheKey)) {
    return cached.events;
  }

  const contract = new ethers.Contract(
    ADDRESSES.audit,
    AUDIT_ABI,
    provider,
  );

  const startBlock = cached ? cached.lastBlock + 1 : effectiveFrom;
  const audits: AuditEvent[] = [];

  const auditFilter = contract.filters.AuditSettled(geniusAddress);
  const auditEvents = await queryFilterChunked(contract, auditFilter, startBlock);

  for (const event of auditEvents) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    audits.push({
      genius: log.args.genius as string,
      idiot: log.args.idiot as string,
      cycle: BigInt(log.args.cycle),
      qualityScore: BigInt(log.args.qualityScore),
      trancheA: BigInt(log.args.trancheA),
      trancheB: BigInt(log.args.trancheB),
      protocolFee: BigInt(log.args.protocolFee),
      isEarlyExit: false,
      blockNumber: log.blockNumber,
    });
  }

  const earlyExitFilter = contract.filters.EarlyExitSettled(geniusAddress);
  const earlyExitEvents = await queryFilterChunked(contract, earlyExitFilter, startBlock);

  for (const event of earlyExitEvents) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    audits.push({
      genius: log.args.genius as string,
      idiot: log.args.idiot as string,
      cycle: BigInt(log.args.cycle),
      qualityScore: BigInt(log.args.qualityScore),
      trancheA: 0n,
      trancheB: BigInt(log.args.creditsAwarded),
      protocolFee: 0n,
      isEarlyExit: true,
      blockNumber: log.blockNumber,
    });
  }

  audits.sort((a, b) => b.blockNumber - a.blockNumber);

  const all = cached
    ? auditCache.merge(cacheKey, audits, getMaxBlock(audits, cached.lastBlock))
    : audits;
  if (!cached) {
    auditCache.set(cacheKey, all, getMaxBlock(audits, effectiveFrom));
  }

  // Re-sort merged results
  return [...all].sort((a, b) => b.blockNumber - a.blockNumber);
}

export async function getAuditsByIdiot(
  provider: ethers.Provider,
  idiotAddress: string,
  fromBlock?: number,
): Promise<AuditEvent[]> {
  const effectiveFrom = fromBlock ?? await resolveDeployBlock(provider);
  const cacheKey = `audits:idiot:${idiotAddress.toLowerCase()}`;
  const cached = auditCache.get(cacheKey);

  if (cached && auditCache.isFresh(cacheKey)) {
    return cached.events;
  }

  const contract = new ethers.Contract(
    ADDRESSES.audit,
    AUDIT_ABI,
    provider,
  );

  const startBlock = cached ? cached.lastBlock + 1 : effectiveFrom;
  const audits: AuditEvent[] = [];

  const auditFilter = contract.filters.AuditSettled(null, idiotAddress);
  const auditEvents = await queryFilterChunked(contract, auditFilter, startBlock);

  for (const event of auditEvents) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    audits.push({
      genius: log.args.genius as string,
      idiot: log.args.idiot as string,
      cycle: BigInt(log.args.cycle),
      qualityScore: BigInt(log.args.qualityScore),
      trancheA: BigInt(log.args.trancheA),
      trancheB: BigInt(log.args.trancheB),
      protocolFee: BigInt(log.args.protocolFee),
      isEarlyExit: false,
      blockNumber: log.blockNumber,
    });
  }

  const earlyExitFilter = contract.filters.EarlyExitSettled(null, idiotAddress);
  const earlyExitEvents = await queryFilterChunked(contract, earlyExitFilter, startBlock);

  for (const event of earlyExitEvents) {
    const log = event as ethers.EventLog;
    if (!log.args) continue;

    audits.push({
      genius: log.args.genius as string,
      idiot: log.args.idiot as string,
      cycle: BigInt(log.args.cycle),
      qualityScore: BigInt(log.args.qualityScore),
      trancheA: 0n,
      trancheB: BigInt(log.args.creditsAwarded),
      protocolFee: 0n,
      isEarlyExit: true,
      blockNumber: log.blockNumber,
    });
  }

  audits.sort((a, b) => b.blockNumber - a.blockNumber);

  const all = cached
    ? auditCache.merge(cacheKey, audits, getMaxBlock(audits, cached.lastBlock))
    : audits;
  if (!cached) {
    auditCache.set(cacheKey, all, getMaxBlock(audits, effectiveFrom));
  }

  return [...all].sort((a, b) => b.blockNumber - a.blockNumber);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMaxBlock(
  events: { blockNumber: number }[],
  fallback: number,
): number {
  if (events.length === 0) return fallback;
  return Math.max(...events.map((e) => e.blockNumber));
}
