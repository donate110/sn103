import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, SIGNAL_COMMITMENT_ABI } from "@/lib/contracts";

/**
 * GET /api/idiot/browse
 *
 * Browse available signals with filtering and sorting.
 * No authentication required (public marketplace).
 *
 * Query params:
 *   sport      - Filter by sport key
 *   genius     - Filter by genius address
 *   sort       - Sort: fee, expires_soon (default: expires_soon)
 *   limit      - Max results (default 20, max 100)
 *   offset     - Pagination offset
 */

// Event scanning (getLogs) needs large block ranges that Alchemy free tier
// doesn't support (10-block limit). Use the public RPC for scanning and
// Alchemy for point queries (isActive, getBalance) which are rate-limited
// on the public RPC from Vercel's shared IPs.
const SCAN_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const QUERY_RPC_URL = process.env.BASE_RPC_URL || SCAN_RPC_URL;
const MAX_LIMIT = 100;
const DEPLOY_BLOCK = Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "0");
const CHUNK_SIZE = 9_999; // Max blocks per queryFilter call (RPC provider limit)

// In-memory cache for the browse endpoint to avoid re-scanning on every request.
// Serverless cold starts will re-populate, but warm instances serve instantly.
let browseCache: { signals: Record<string, unknown>[]; lastBlock: number; updatedAt: number } | null = null;
const BROWSE_CACHE_TTL_MS = 30_000; // 30 seconds: balances freshness vs RPC load
const BROWSE_CACHE_HARD_TTL_MS = 300_000; // 5 minutes: full rescan to catch cancellations

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sport = searchParams.get("sport");
  const genius = searchParams.get("genius");
  const sortBy = searchParams.get("sort") || "expires_soon";
  const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), MAX_LIMIT);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (genius && !ethers.isAddress(genius)) {
    return NextResponse.json(
      { error: "invalid_address", message: "genius must be a valid Ethereum address" },
      { status: 400 },
    );
  }

  if (ADDRESSES.signalCommitment === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({ signals: [], total: 0, offset, limit });
  }

  try {
    const scanProvider = new ethers.JsonRpcProvider(SCAN_RPC_URL);
    const queryProvider = QUERY_RPC_URL !== SCAN_RPC_URL
      ? new ethers.JsonRpcProvider(QUERY_RPC_URL)
      : scanProvider;
    // Use public RPC for event scanning (large block ranges)
    const scanContract = new ethers.Contract(
      ADDRESSES.signalCommitment,
      SIGNAL_COMMITMENT_ABI,
      scanProvider,
    );
    // Use Alchemy for point queries (isActive) to avoid public RPC rate limits
    const queryContract = new ethers.Contract(
      ADDRESSES.signalCommitment,
      SIGNAL_COMMITMENT_ABI,
      queryProvider,
    );
    // Alias for backward compatibility in cached-results path
    const contract = scanContract;
    const provider = scanProvider;

    // Use cached results if fresh enough (unless bust param forces bypass)
    const bust = searchParams.has("bust");
    const now = Math.floor(Date.now() / 1000);
    if (!bust && browseCache && Date.now() - browseCache.updatedAt < BROWSE_CACHE_TTL_MS) {
      // Filter cached signals (remove newly expired ones)
      const signals = browseCache.signals.filter((s) => {
        if ((s.expires_at_unix as number) < now) return false;
        if (sport && s.sport !== sport) return false;
        if (genius && (s.genius as string).toLowerCase() !== ethers.getAddress(genius).toLowerCase()) return false;
        return true;
      });

      if (sortBy === "expires_soon") {
        signals.sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));
      } else if (sortBy === "fee") {
        signals.sort((a, b) => (a.fee_bps as number) - (b.fee_bps as number));
      }

      const paged = signals.slice(offset, offset + limit);
      return NextResponse.json({ signals: paged, total: signals.length, offset, limit }, {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
        },
      });
    }

    // If we have a stale cache, do an incremental scan from lastBlock + 1
    // instead of rescanning the full 7-day range. This makes stale-cache
    // refreshes nearly instant (only a handful of new blocks to scan).
    const geniusFilter = genius ? ethers.getAddress(genius) : null;
    const filter = contract.filters.SignalCommitted(null, geniusFilter);
    const currentBlock = await provider.getBlockNumber();
    const SEVEN_DAYS_BLOCKS = 604_800; // ~7 days at 2 blocks/sec
    const fullScanFrom = Math.max(DEPLOY_BLOCK, currentBlock - SEVEN_DAYS_BLOCKS);
    // Incremental scan if cache exists and isn't too old; full scan otherwise
    const cacheIsRecent = browseCache !== null && (Date.now() - browseCache.updatedAt < BROWSE_CACHE_HARD_TTL_MS);
    const fromBlock = (cacheIsRecent && browseCache) ? browseCache.lastBlock + 1 : fullScanFrom;

    // Build chunk ranges and query with limited concurrency to avoid RPC rate limits
    const chunkRanges: [number, number][] = [];
    for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE) {
      chunkRanges.push([start, Math.min(start + CHUNK_SIZE - 1, currentBlock)]);
    }
    const events: (ethers.EventLog | ethers.Log)[] = [];
    const CONCURRENCY = 20;
    for (let i = 0; i < chunkRanges.length; i += CONCURRENCY) {
      const batch = chunkRanges.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(([start, end]) =>
          contract.queryFilter(filter, start, end),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          events.push(...result.value);
        }
      }
    }

    const signals: Record<string, unknown>[] = [];

    // Pre-filter expired events before enrichment (avoids RPC calls for dead signals)
    const activeEvents = events.reverse().filter((event) => {
      const args = (event as ethers.EventLog).args;
      if (!args) return false;
      return Number(args.expiresAt) >= now;
    });

    // Batch isActive checks with controlled concurrency
    const ENRICH_CONCURRENCY = 15;
    const enrichmentPromises = activeEvents.map(async (event) => {
      const args = (event as ethers.EventLog).args;
      if (!args) return null;

      const signalId = args.signalId;
      const expiresAt = Number(args.expiresAt);

      // Check if still active on-chain (single RPC call, skip getSignal)
      try {
        const isActive = await queryContract.isActive(signalId);
        if (!isActive) return null;
      } catch {
        return null;
      }

      // Use minNotional from event args if available, else default
      const minNotional = args.minNotional?.toString() ?? "0";

      return {
        signal_id: signalId.toString(),
        genius: args.genius,
        sport: args.sport,
        fee_bps: Number(args.maxPriceBps),
        sla_multiplier_bps: Number(args.slaMultiplierBps),
        max_notional: args.maxNotional.toString(),
        min_notional: minNotional,
        expires_at_unix: expiresAt,
        max_notional_usdc: Number(args.maxNotional) / 1e6,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      };
    });

    // Process enrichment in batches to avoid overwhelming RPC
    const enriched: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < enrichmentPromises.length; i += ENRICH_CONCURRENCY) {
      const batch = enrichmentPromises.slice(i, i + ENRICH_CONCURRENCY);
      const results = await Promise.all(batch);
      enriched.push(...results);
    }
    for (const s of enriched) {
      if (s) signals.push(s);
    }

    // Merge with existing cache (incremental) or replace (full scan)
    if (cacheIsRecent && browseCache) {
      // Incremental: keep existing signals, add new ones, prune expired
      const newIds = new Set(signals.map((s) => s.signal_id as string));
      const kept = browseCache.signals.filter((s) => {
        if ((s.expires_at_unix as number) < now) return false;
        if (newIds.has(s.signal_id as string)) return false; // replaced by fresh version
        return true;
      });
      browseCache = { signals: [...kept, ...signals], lastBlock: currentBlock, updatedAt: Date.now() };
    } else {
      browseCache = { signals: [...signals], lastBlock: currentBlock, updatedAt: Date.now() };
    }

    // Apply filters from the full cache (not just newly scanned signals)
    const allSignals = browseCache?.signals ?? signals;
    const filtered = allSignals.filter((s) => {
      if ((s.expires_at_unix as number) < now) return false;
      if (sport && s.sport !== sport) return false;
      if (genius && (s.genius as string).toLowerCase() !== ethers.getAddress(genius).toLowerCase()) return false;
      return true;
    });

    // Sort
    if (sortBy === "expires_soon") {
      filtered.sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));
    } else if (sortBy === "fee") {
      filtered.sort((a, b) => (a.fee_bps as number) - (b.fee_bps as number));
    }

    const paged = filtered.slice(offset, offset + limit);

    return NextResponse.json({
      signals: paged,
      total: filtered.length,
      offset,
      limit,
    }, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    console.error("browse_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch signals" },
      { status: 500 },
    );
  }
}
