import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, SIGNAL_COMMITMENT_ABI } from "@/lib/contracts";

/**
 * GET /api/genius/signals?address=0x...&status=active&sport=basketball_nba&limit=20&offset=0
 *
 * List all signals for a genius. All data is on-chain and public.
 */

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const MAX_LIMIT = 100;
const SCAN_BLOCKS = 200_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  const statusFilter = searchParams.get("status"); // active, expired, cancelled
  const sportFilter = searchParams.get("sport");
  const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), MAX_LIMIT);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Provide a valid Ethereum address as ?address=0x..." },
      { status: 400 },
    );
  }

  if (ADDRESSES.signalCommitment === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({ signals: [], total: 0, offset, limit });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const checksumAddr = ethers.getAddress(address);
    const contract = new ethers.Contract(
      ADDRESSES.signalCommitment,
      SIGNAL_COMMITMENT_ABI,
      provider,
    );

    // Query SignalCommitted events for this genius (chunked to avoid RPC limits)
    const filter = contract.filters.SignalCommitted(null, checksumAddr);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - SCAN_BLOCKS);
    const CHUNK_SIZE = 9_999;
    const events: (ethers.EventLog | ethers.Log)[] = [];
    const CONCURRENCY = 10;
    const chunkRanges: [number, number][] = [];
    for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE) {
      chunkRanges.push([start, Math.min(start + CHUNK_SIZE - 1, currentBlock)]);
    }
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

    for (const event of events.reverse()) {
      const args = (event as ethers.EventLog).args;
      if (!args) continue;

      const signalId = args.signalId;
      const sport = args.sport;
      const feeBps = Number(args.maxPriceBps);
      const slaBps = Number(args.slaMultiplierBps);
      const maxNotional = Number(args.maxNotional);
      const expiresAt = Number(args.expiresAt);

      // Determine status
      let status = "active";
      try {
        const isActive = await contract.isActive(signalId);
        if (!isActive) status = "cancelled";
      } catch {
        status = "unknown";
      }
      if (status === "active" && expiresAt < now) status = "expired";

      // Apply filters
      if (statusFilter && status !== statusFilter) continue;
      if (sportFilter && sport !== sportFilter) continue;

      signals.push({
        signal_id: signalId.toString(),
        sport,
        fee_bps: feeBps,
        sla_multiplier_bps: slaBps,
        max_notional_usdc: maxNotional / 1e6,
        expires_at: new Date(expiresAt * 1000).toISOString(),
        status,
        block_number: event.blockNumber,
      });

      if (signals.length >= offset + limit + 20) break;
    }

    const paged = signals.slice(offset, offset + limit);

    return NextResponse.json({
      signals: paged,
      total: signals.length,
      offset,
      limit,
    });
  } catch (error) {
    console.error("genius_signals_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch signals" },
      { status: 500 },
    );
  }
}
