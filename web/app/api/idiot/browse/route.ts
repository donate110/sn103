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

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const MAX_LIMIT = 100;
const SCAN_BLOCKS = 100_000; // How far back to scan for SignalCommitted events

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
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(
      ADDRESSES.signalCommitment,
      SIGNAL_COMMITMENT_ABI,
      provider,
    );

    // Query SignalCommitted events to find signal IDs
    const geniusFilter = genius ? ethers.getAddress(genius) : null;
    const filter = contract.filters.SignalCommitted(null, geniusFilter);
    const events = await contract.queryFilter(filter, -SCAN_BLOCKS);

    const now = Math.floor(Date.now() / 1000);
    const signals: Record<string, unknown>[] = [];

    // Fetch signal details for each event
    for (const event of events.reverse()) {
      const args = (event as ethers.EventLog).args;
      if (!args) continue;

      const signalId = args.signalId;
      const eventSport = args.sport;
      const feeBps = Number(args.maxPriceBps);
      const slaBps = Number(args.slaMultiplierBps);
      const maxNotional = Number(args.maxNotional);
      const expiresAt = Number(args.expiresAt);
      const signalGenius = args.genius;

      // Skip expired
      if (expiresAt < now) continue;

      // Apply sport filter
      if (sport && eventSport !== sport) continue;

      // Check if still active on-chain
      try {
        const isActive = await contract.isActive(signalId);
        if (!isActive) continue;
      } catch {
        continue;
      }

      signals.push({
        signal_id: signalId.toString(),
        genius: signalGenius,
        sport: eventSport,
        fee_bps: feeBps,
        sla_multiplier_bps: slaBps,
        max_notional_usdc: maxNotional / 1e6,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      });

      // Stop scanning once we have enough candidates
      if (signals.length >= offset + limit + 50) break;
    }

    // Sort
    if (sortBy === "expires_soon") {
      signals.sort((a, b) => String(a.expires_at).localeCompare(String(b.expires_at)));
    } else if (sortBy === "fee") {
      signals.sort((a, b) => (a.fee_bps as number) - (b.fee_bps as number));
    }

    const paged = signals.slice(offset, offset + limit);

    return NextResponse.json({
      signals: paged,
      total: signals.length,
      offset,
      limit,
    });
  } catch (error) {
    console.error("browse_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch signals" },
      { status: 500 },
    );
  }
}
