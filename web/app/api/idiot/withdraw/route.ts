import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { ADDRESSES, ESCROW_ABI } from "@/lib/contracts";

/**
 * POST /api/idiot/withdraw
 *
 * Auth required. Returns unsigned withdraw transaction data for the
 * Escrow contract's `withdraw(amount)` function.
 *
 * Body: { amount_usdc: number }
 * Response: { tx: { to, data, chainId }, amount_usdc }
 *
 * The client signs and submits the transaction. The API never holds private keys.
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

export async function POST(request: NextRequest) {
  if (isRateLimited("idiot-withdraw", getIp(request), 30)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  let body: { amount_usdc?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const { amount_usdc } = body;

  if (
    amount_usdc == null ||
    typeof amount_usdc !== "number" ||
    amount_usdc <= 0
  ) {
    return NextResponse.json(
      {
        error: "invalid_amount",
        message: "amount_usdc must be a positive number",
      },
      { status: 400 },
    );
  }

  if (ADDRESSES.escrow === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json(
      {
        error: "not_configured",
        message: "Escrow contract address is not configured",
      },
      { status: 503 },
    );
  }

  try {
    // Convert human-readable USDC to on-chain amount (6 decimals)
    const amountOnChain = BigInt(Math.round(amount_usdc * 1e6));

    const escrowIface = new ethers.Interface(ESCROW_ABI);
    const calldata = escrowIface.encodeFunctionData("withdraw", [
      amountOnChain,
    ]);

    return NextResponse.json({
      amount_usdc,
      tx: {
        to: ADDRESSES.escrow,
        data: calldata,
        chainId: CHAIN_ID,
      },
    });
  } catch (error) {
    console.error("withdraw_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to prepare withdraw transaction" },
      { status: 500 },
    );
  }
}
