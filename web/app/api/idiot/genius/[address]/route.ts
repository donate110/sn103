import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, AUDIT_ABI } from "@/lib/contracts";

/**
 * GET /api/idiot/genius/{address}/profile
 *
 * View a genius's public track record and performance history.
 * No authentication required (public data from on-chain audits).
 */

const RPC_URL = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;

  if (!ethers.isAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Must be a valid Ethereum address" },
      { status: 400 },
    );
  }

  try {
    const checksumAddr = ethers.getAddress(address);
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Query AuditSetSettled events for this genius
    const auditContract = new ethers.Contract(ADDRESSES.audit, AUDIT_ABI, provider);

    let settlements: {
      cycle: number;
      quality_score: number;
      favorable: number;
      unfavorable: number;
      void_count: number;
      settled_at: string;
    }[] = [];

    try {
      const filter = auditContract.filters.AuditSetSettled(checksumAddr);
      const events = await auditContract.queryFilter(filter, -100000);

      settlements = events.map((event) => {
        const args = (event as ethers.EventLog).args;
        return {
          cycle: Number(args?.cycle || 0),
          quality_score: Number(args?.qualityScore || 0),
          favorable: Number(args?.favorable || 0),
          unfavorable: Number(args?.unfavorable || 0),
          void_count: Number(args?.voidCount || 0),
          settled_at: new Date(Number(args?.timestamp || 0) * 1000).toISOString(),
        };
      });
    } catch {
      // Audit events may not be available yet
    }

    const totalSettled = settlements.length;
    const totalFavorable = settlements.reduce((s, a) => s + a.favorable, 0);
    const totalUnfavorable = settlements.reduce((s, a) => s + a.unfavorable, 0);
    const totalVoid = settlements.reduce((s, a) => s + a.void_count, 0);
    const totalSignals = totalFavorable + totalUnfavorable + totalVoid;
    const winRate = totalSignals > 0 ? totalFavorable / (totalFavorable + totalUnfavorable) : 0;
    const avgQualityScore = totalSettled > 0
      ? settlements.reduce((s, a) => s + a.quality_score, 0) / totalSettled
      : 0;

    return NextResponse.json({
      address: checksumAddr,
      quality_score_avg: Math.round(avgQualityScore),
      total_signals: totalSignals,
      settled_cycles: totalSettled,
      win_rate: Math.round(winRate * 100) / 100,
      favorable: totalFavorable,
      unfavorable: totalUnfavorable,
      void: totalVoid,
      recent_settlements: settlements.slice(-10).reverse(),
    });
  } catch (error) {
    console.error("genius_profile_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch genius profile" },
      { status: 500 },
    );
  }
}
