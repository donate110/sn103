import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import {
  ADDRESSES,
  SIGNAL_COMMITMENT_ABI,
  ESCROW_ABI,
} from "@/lib/contracts";

/**
 * POST /api/idiot/purchase
 *
 * Auth required. Validates a signal and returns unsigned purchase transaction
 * data for the Escrow contract's `purchase(signalId, notional, odds)` function.
 *
 * Body: { signal_id: string, notional_usdc: number }
 * Response: { signal_id, notional_usdc, fee_usdc, tx: { to, data, chainId } }
 *
 * The client signs and submits the transaction. The API never holds private keys.
 */

const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");

export async function POST(request: NextRequest) {
  if (isRateLimited("idiot-purchase", getIp(request), 30)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  let body: { signal_id?: string; notional_usdc?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const { signal_id, notional_usdc } = body;

  if (!signal_id || typeof signal_id !== "string") {
    return NextResponse.json(
      { error: "invalid_signal_id", message: "signal_id is required (string)" },
      { status: 400 },
    );
  }

  if (
    notional_usdc == null ||
    typeof notional_usdc !== "number" ||
    notional_usdc <= 0
  ) {
    return NextResponse.json(
      {
        error: "invalid_notional",
        message: "notional_usdc must be a positive number",
      },
      { status: 400 },
    );
  }

  if (
    ADDRESSES.signalCommitment ===
    "0x0000000000000000000000000000000000000000"
  ) {
    return NextResponse.json(
      {
        error: "not_configured",
        message: "SignalCommitment contract address is not configured",
      },
      { status: 503 },
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
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signalContract = new ethers.Contract(
      ADDRESSES.signalCommitment,
      SIGNAL_COMMITMENT_ABI,
      provider,
    );

    // Parse signal ID as bigint
    let signalIdBn: bigint;
    try {
      signalIdBn = BigInt(signal_id);
    } catch {
      return NextResponse.json(
        { error: "invalid_signal_id", message: "signal_id must be a valid integer" },
        { status: 400 },
      );
    }

    // Check signal exists and is active
    const [exists, isActive] = await Promise.all([
      signalContract.signalExists(signalIdBn).catch(() => false),
      signalContract.isActive(signalIdBn).catch(() => false),
    ]);

    if (!exists) {
      return NextResponse.json(
        { error: "signal_not_found", message: `Signal ${signal_id} does not exist` },
        { status: 404 },
      );
    }

    if (!isActive) {
      return NextResponse.json(
        {
          error: "signal_not_active",
          message: `Signal ${signal_id} is not active (may be expired, cancelled, or settled)`,
        },
        { status: 409 },
      );
    }

    // Fetch signal details
    const signalData = await signalContract.getSignal(signalIdBn);
    const maxPriceBps = Number(signalData.maxPriceBps);
    const maxNotional = BigInt(signalData.maxNotional);
    const minNotional = BigInt(signalData.minNotional);
    const expiresAt = Number(signalData.expiresAt);

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt < now) {
      return NextResponse.json(
        { error: "signal_expired", message: `Signal ${signal_id} has expired` },
        { status: 409 },
      );
    }

    // Convert human-readable USDC to on-chain amount (6 decimals)
    const notionalOnChain = BigInt(Math.round(notional_usdc * 1e6));

    // Validate notional bounds
    if (notionalOnChain < minNotional) {
      return NextResponse.json(
        {
          error: "notional_too_small",
          message: `Notional $${notional_usdc} is below the signal minimum of $${Number(minNotional) / 1e6}`,
        },
        { status: 400 },
      );
    }

    if (notionalOnChain > maxNotional) {
      return NextResponse.json(
        {
          error: "notional_too_large",
          message: `Notional $${notional_usdc} exceeds the signal maximum of $${Number(maxNotional) / 1e6}`,
        },
        { status: 400 },
      );
    }

    // Calculate fee: notional * maxPriceBps / 10000
    const feeOnChain = (notionalOnChain * BigInt(maxPriceBps)) / 10000n;
    const feeUsdc = Number(feeOnChain) / 1e6;

    // Encode unsigned purchase transaction
    // purchase(signalId, notional, odds) - odds is set to 0 (market odds determined on-chain)
    const escrowIface = new ethers.Interface(ESCROW_ABI);
    const calldata = escrowIface.encodeFunctionData("purchase", [
      signalIdBn,
      notionalOnChain,
      0, // odds placeholder; actual odds come from the sportsbook at execution time
    ]);

    return NextResponse.json({
      signal_id,
      notional_usdc,
      fee_usdc: feeUsdc,
      tx: {
        to: ADDRESSES.escrow,
        data: calldata,
        chainId: CHAIN_ID,
      },
    });
  } catch (error) {
    console.error("purchase_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to prepare purchase transaction" },
      { status: 500 },
    );
  }
}
