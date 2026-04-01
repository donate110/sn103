import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { ADDRESSES, SIGNAL_COMMITMENT_ABI } from "@/lib/contracts";

/**
 * DELETE /api/genius/signal/[id]
 *
 * Returns an unsigned cancelSignal transaction for the client to sign and submit.
 * The API never holds private keys.
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const RATE_LIMIT_MAX = 30;

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  if (isRateLimited("genius-signal-cancel", getIp(request), RATE_LIMIT_MAX)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  const signalId = params.id;
  if (!signalId) {
    return NextResponse.json(
      { error: "missing_signal_id", message: "Signal ID is required" },
      { status: 400 },
    );
  }

  // Validate signal ID is a valid uint256
  let signalIdBn: bigint;
  try {
    signalIdBn = BigInt(signalId);
    if (signalIdBn < 0n) throw new Error("negative");
  } catch {
    return NextResponse.json(
      { error: "invalid_signal_id", message: "Signal ID must be a valid non-negative integer" },
      { status: 400 },
    );
  }

  if (ADDRESSES.signalCommitment === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json(
      { error: "not_configured", message: "SignalCommitment contract address is not configured" },
      { status: 503 },
    );
  }

  // Encode the cancelSignal(uint256) call
  const iface = new ethers.Interface(SIGNAL_COMMITMENT_ABI);
  const data = iface.encodeFunctionData("cancelSignal", [signalIdBn]);

  return NextResponse.json({
    signal_id: signalId,
    tx: {
      to: ADDRESSES.signalCommitment,
      data,
      chainId: CHAIN_ID,
    },
  });
}
