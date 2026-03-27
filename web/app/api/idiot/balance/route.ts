import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ADDRESSES, ESCROW_ABI, ERC20_ABI, CREDIT_LEDGER_ABI } from "@/lib/contracts";

/**
 * GET /api/idiot/balance?address=0x...
 *
 * Returns escrow balance, USDC wallet balance, and credit balance for an idiot.
 * No authentication required (all data is on-chain and public).
 */

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");

  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json(
      { error: "invalid_address", message: "Provide a valid Ethereum address as ?address=0x..." },
      { status: 400 },
    );
  }

  if (ADDRESSES.escrow === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({
      address,
      escrow_balance_usdc: 0,
      wallet_usdc: 0,
      credits: 0,
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const checksumAddr = ethers.getAddress(address);

    // Parallel RPC calls
    const [escrowBalance, walletUsdc, credits] = await Promise.all([
      // Escrow balance
      new ethers.Contract(ADDRESSES.escrow, ESCROW_ABI, provider)
        .getBalance(checksumAddr)
        .catch(() => 0n),
      // Wallet USDC balance
      new ethers.Contract(ADDRESSES.usdc, ERC20_ABI, provider)
        .balanceOf(checksumAddr)
        .catch(() => 0n),
      // Djinn Credits
      ADDRESSES.creditLedger !== "0x0000000000000000000000000000000000000000"
        ? new ethers.Contract(ADDRESSES.creditLedger, CREDIT_LEDGER_ABI, provider)
            .balanceOf(checksumAddr)
            .catch(() => 0n)
        : Promise.resolve(0n),
    ]);

    return NextResponse.json({
      address: checksumAddr,
      escrow_balance_usdc: Number(escrowBalance) / 1e6,
      wallet_usdc: Number(walletUsdc) / 1e6,
      credits: Number(credits) / 1e6,
    });
  } catch (error) {
    console.error("balance_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch balance" },
      { status: 500 },
    );
  }
}
