import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, COLLATERAL_ABI, AUDIT_ABI } from "@/lib/contracts";

/**
 * GET /api/genius/earnings?address=0x...
 *
 * Returns collateral status, settlement history, and aggregate quality score
 * for a genius. All data is on-chain and public.
 */

const RPC_URL = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");

  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Provide a valid Ethereum address as ?address=0x..." },
      { status: 400 },
    );
  }

  if (ADDRESSES.collateral === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({
      address,
      collateral_deposited_usdc: 0,
      collateral_locked_usdc: 0,
      collateral_available_usdc: 0,
      settled_batches: 0,
      quality_score_avg: 0,
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const checksumAddr = ethers.getAddress(address);

    // Collateral data
    const collateralContract = new ethers.Contract(
      ADDRESSES.collateral,
      COLLATERAL_ABI,
      provider,
    );

    const [deposit, locked] = await Promise.all([
      collateralContract.deposits(checksumAddr).catch(() => 0n),
      collateralContract.locked(checksumAddr).catch(() => 0n),
    ]);

    const depositUsdc = Number(deposit) / 1e6;
    const lockedUsdc = Number(locked) / 1e6;

    // Settlement history from audit events
    let settlements: { cycle: number; quality_score: number }[] = [];
    try {
      const auditContract = new ethers.Contract(ADDRESSES.audit, AUDIT_ABI, provider);
      const filter = auditContract.filters.AuditSetSettled(checksumAddr);
      const events = await auditContract.queryFilter(filter, -200000);
      settlements = events.map((event) => {
        const args = (event as ethers.EventLog).args;
        return {
          cycle: Number(args?.cycle || 0),
          quality_score: Number(args?.qualityScore || 0),
        };
      });
    } catch {
      // Events may not be available
    }

    const avgScore = settlements.length > 0
      ? settlements.reduce((s, a) => s + a.quality_score, 0) / settlements.length
      : 0;

    return NextResponse.json({
      address: checksumAddr,
      collateral_deposited_usdc: depositUsdc,
      collateral_locked_usdc: lockedUsdc,
      collateral_available_usdc: depositUsdc - lockedUsdc,
      settled_batches: settlements.length,
      quality_score_avg: Math.round(avgScore),
      recent_settlements: settlements.slice(-10).reverse(),
    });
  } catch (error) {
    console.error("earnings_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch earnings" },
      { status: 500 },
    );
  }
}
