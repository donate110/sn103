import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { createChallenge, buildChallengeMessage } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/auth/connect
 *
 * Initiate an API session. Returns a challenge nonce the client must sign
 * with their wallet to prove ownership.
 *
 * Body: { address: "0x..." }
 * Response: { challenge: "Sign this message...", nonce: "abc123...", expires_in: 300 }
 */
export async function POST(request: NextRequest) {
  if (isRateLimited("auth-connect", getIp(request), 60_000, 20)) {
    return rateLimitResponse();
  }

  try {
    const body = await request.json();
    const { address } = body;

    if (!address || typeof address !== "string") {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }

    let checksummed: string;
    try {
      checksummed = ethers.getAddress(address);
    } catch {
      return NextResponse.json({ error: "Invalid Ethereum address" }, { status: 400 });
    }

    const nonce = await createChallenge(checksummed);
    const challenge = buildChallengeMessage(nonce);

    return NextResponse.json({
      challenge,
      nonce,
      expires_in: 300,
    });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}
