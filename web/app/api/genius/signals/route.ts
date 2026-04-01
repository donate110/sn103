import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, SIGNAL_COMMITMENT_ABI } from "@/lib/contracts";

/**
 * GET /api/genius/signals?address=0x...&limit=20&offset=0&include_all=1
 *
 * List all signals for a genius. All data is on-chain and public.
 * Returns field names compatible with the client hooks (max_notional, expires_at_unix, etc).
 */

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const MAX_LIMIT = 100;
const SCAN_BLOCKS = 1_500_000; // ~8.5 days at 2 blocks/sec on Base Sepolia
const CHUNK_SIZE = 9_999;
const CONCURRENCY = 10;

// Per-address in-memory cache
const geniusCache = new Map<string, { signals: Record<string, unknown>[]; updatedAt: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), MAX_LIMIT);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const includeAll = searchParams.get("include_all") === "1";

  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Provide a valid Ethereum address as ?address=0x..." },
      { status: 400 },
    );
  }

  if (ADDRESSES.signalCommitment === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({ signals: [], total: 0, offset, limit });
  }

  const checksumAddr = ethers.getAddress(address);
  const cacheKey = checksumAddr.toLowerCase();
  const bust = searchParams.has("bust"); // Client can force cache bypass after mutations

  // Serve from cache if fresh (unless bust param present)
  const cached = geniusCache.get(cacheKey);
  if (!bust && cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    const now = Math.floor(Date.now() / 1000);
    const filtered = includeAll
      ? cached.signals
      : cached.signals.filter((s) => (s.expires_at_unix as number) >= now && s.status === "active");
    const paged = filtered.slice(offset, offset + limit);
    return NextResponse.json({ signals: paged, total: filtered.length, offset, limit }, {
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(ADDRESSES.signalCommitment, SIGNAL_COMMITMENT_ABI, provider);

    // Query SignalCommitted events for this genius (chunked)
    const filter = contract.filters.SignalCommitted(null, checksumAddr);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - SCAN_BLOCKS);
    const chunkRanges: [number, number][] = [];
    for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE) {
      chunkRanges.push([start, Math.min(start + CHUNK_SIZE - 1, currentBlock)]);
    }

    const events: (ethers.EventLog | ethers.Log)[] = [];
    for (let i = 0; i < chunkRanges.length; i += CONCURRENCY) {
      const batch = chunkRanges.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(([start, end]) => contract.queryFilter(filter, start, end)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") events.push(...result.value);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const signals: Record<string, unknown>[] = [];

    // Batch isActive checks with concurrency control
    const ENRICH = 15;
    const enrichFns = events.reverse().map((event) => async () => {
      const args = (event as ethers.EventLog).args;
      if (!args) return null;

      const expiresAt = Number(args.expiresAt);
      let status = "active";
      if (expiresAt < now) status = "expired";

      if (status === "active") {
        try {
          const isActive = await contract.isActive(args.signalId);
          if (!isActive) status = "cancelled";
        } catch {
          status = "unknown";
        }
      }

      return {
        signal_id: args.signalId.toString(),
        genius: checksumAddr,
        sport: args.sport,
        fee_bps: Number(args.maxPriceBps),
        sla_multiplier_bps: Number(args.slaMultiplierBps),
        max_notional: args.maxNotional.toString(),
        min_notional: "0", // Not in event; hook handles this gracefully
        expires_at_unix: expiresAt,
        status,
        block_number: event.blockNumber,
      };
    });

    // Process in batches
    for (let i = 0; i < enrichFns.length; i += ENRICH) {
      const batch = enrichFns.slice(i, i + ENRICH);
      const results = await Promise.all(batch.map((fn) => fn()));
      for (const s of results) {
        if (s) signals.push(s);
      }
    }

    // Cache all signals (unfiltered)
    geniusCache.set(cacheKey, { signals: [...signals], updatedAt: Date.now() });

    // Evict stale cache entries (prevent memory leak)
    if (geniusCache.size > 100) {
      const cutoff = Date.now() - CACHE_TTL_MS * 10;
      for (const [key, val] of geniusCache) {
        if (val.updatedAt < cutoff) geniusCache.delete(key);
      }
    }

    // Filter for response
    const filtered = includeAll
      ? signals
      : signals.filter((s) => s.status === "active");

    const paged = filtered.slice(offset, offset + limit);

    return NextResponse.json({
      signals: paged,
      total: filtered.length,
      offset,
      limit,
    }, {
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
    });
  } catch (error) {
    console.error("genius_signals_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch signals" },
      { status: 500 },
    );
  }
}
