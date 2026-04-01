import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { ADDRESSES, COLLATERAL_ABI } from "@/lib/contracts";

/**
 * POST /api/genius/collateral/withdraw
 *
 * Returns unsigned transaction data for withdrawing unlocked collateral.
 * The client signs and submits. The API never holds private keys.
 *
 * Body: { amount_usdc: number } (human-readable, e.g. 1000 = $1000)
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const USDC_DECIMALS = 6;
const RATE_LIMIT_MAX = 30;

export async function POST(request: NextRequest) {
  if (isRateLimited("genius-collateral-withdraw", getIp(request), RATE_LIMIT_MAX)) {
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

  if (typeof amount_usdc !== "number" || amount_usdc <= 0) {
    return NextResponse.json(
      { error: "invalid_amount", message: "amount_usdc must be a positive number" },
      { status: 400 },
    );
  }

  if (ADDRESSES.collateral === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json(
      { error: "not_configured", message: "Collateral contract address is not configured" },
      { status: 503 },
    );
  }

  // Convert human-readable USDC to on-chain amount (6 decimals)
  const amountOnChain = BigInt(Math.round(amount_usdc * 10 ** USDC_DECIMALS));

  const collateralIface = new ethers.Interface(COLLATERAL_ABI);
  const data = collateralIface.encodeFunctionData("withdraw", [amountOnChain]);

  return NextResponse.json({
    tx: {
      to: ADDRESSES.collateral,
      data,
      chainId: CHAIN_ID,
    },
    amount_usdc,
  });
}
