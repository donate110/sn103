import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, ACCOUNT_ABI } from "@/lib/contracts";

/**
 * GET /api/settlement/{genius}/{idiot}
 *
 * Check settlement status for a genius-idiot pair.
 * Returns current cycle, signals in cycle, and readiness for settlement.
 */

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ genius: string; idiot: string }> },
) {
  const { genius, idiot } = await params;

  if (!ethers.isAddress(genius) || !ethers.isAddress(idiot)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Both genius and idiot must be valid Ethereum addresses" },
      { status: 400 },
    );
  }

  if (ADDRESSES.account === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({
      genius,
      idiot,
      current_cycle: 0,
      signals_in_cycle: 0,
      ready_for_settlement: false,
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const geniusAddr = ethers.getAddress(genius);
    const idiotAddr = ethers.getAddress(idiot);

    const accountContract = new ethers.Contract(
      ADDRESSES.account,
      ACCOUNT_ABI,
      provider,
    );

    const [currentCycle, purchaseIds] = await Promise.all([
      accountContract.getCurrentCycle(geniusAddr, idiotAddr).catch(() => 0n),
      accountContract.getPurchaseIds(geniusAddr, idiotAddr).catch(() => []),
    ]);

    const cycle = Number(currentCycle);
    const signalsInCycle = Array.isArray(purchaseIds) ? purchaseIds.length : 0;
    const readyForSettlement = signalsInCycle >= 10;

    return NextResponse.json({
      genius: geniusAddr,
      idiot: idiotAddr,
      current_cycle: cycle,
      signals_in_cycle: signalsInCycle,
      ready_for_settlement: readyForSettlement,
    });
  } catch (error) {
    console.error("settlement_status_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch settlement status" },
      { status: 500 },
    );
  }
}
