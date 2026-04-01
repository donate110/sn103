import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { ADDRESSES, ERC20_ABI, ESCROW_ABI } from "@/lib/contracts";

/**
 * POST /api/idiot/deposit
 *
 * Auth required. Returns unsigned transaction data for a two-step deposit:
 * 1. Approve USDC spending by the Escrow contract
 * 2. Deposit USDC into the Escrow contract
 *
 * Body: { amount_usdc: number }
 * Response: { approve_tx: { to, data, chainId }, deposit_tx: { to, data, chainId }, amount_usdc }
 *
 * The client signs and submits both transactions. The API never holds private keys.
 */

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

export async function POST(request: NextRequest) {
  if (isRateLimited("idiot-deposit", getIp(request), 30)) {
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

  if (ADDRESSES.usdc === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json(
      {
        error: "not_configured",
        message: "USDC contract address is not configured",
      },
      { status: 503 },
    );
  }

  try {
    // Convert human-readable USDC to on-chain amount (6 decimals)
    const amountOnChain = BigInt(Math.round(amount_usdc * 1e6));

    // Step 1: Approve USDC spending
    const erc20Iface = new ethers.Interface(ERC20_ABI);
    const approveData = erc20Iface.encodeFunctionData("approve", [
      ADDRESSES.escrow,
      amountOnChain,
    ]);

    // Step 2: Deposit into Escrow
    const escrowIface = new ethers.Interface(ESCROW_ABI);
    const depositData = escrowIface.encodeFunctionData("deposit", [
      amountOnChain,
    ]);

    return NextResponse.json({
      amount_usdc,
      approve_tx: {
        to: ADDRESSES.usdc,
        data: approveData,
        chainId: CHAIN_ID,
      },
      deposit_tx: {
        to: ADDRESSES.escrow,
        data: depositData,
        chainId: CHAIN_ID,
      },
    });
  } catch (error) {
    console.error("deposit_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to prepare deposit transactions" },
      { status: 500 },
    );
  }
}
