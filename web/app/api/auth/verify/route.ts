import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import {
  consumeChallenge,
  recoverAddress,
  createSessionToken,
  type SessionScope,
} from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

/**
 * POST /api/auth/verify
 *
 * Submit a signed challenge to receive a session token.
 *
 * Body: {
 *   address: "0x...",
 *   signature: "0x...",
 *   scope?: { role?: "genius"|"idiot"|"both", max_spend_usdc?: number, expires_in_hours?: number }
 * }
 *
 * Response: {
 *   session_token: "djn_...",
 *   expires_at: "2026-04-02T18:00:00Z",
 *   scope: { role: "both", max_spend_usdc: null }
 * }
 */
export async function POST(request: NextRequest) {
  if (isRateLimited("auth-verify", getIp(request), 60_000, 10)) {
    return rateLimitResponse();
  }

  try {
    const body = await request.json();
    const { address, signature, nonce: clientNonce, scope: rawScope } = body;

    if (!address || typeof address !== "string") {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }
    if (!signature || typeof signature !== "string") {
      return NextResponse.json({ error: "signature is required" }, { status: 400 });
    }
    if (!clientNonce || typeof clientNonce !== "string") {
      return NextResponse.json({ error: "nonce is required (from /api/auth/connect)" }, { status: 400 });
    }

    let checksummed: string;
    try {
      checksummed = ethers.getAddress(address);
    } catch {
      return NextResponse.json({ error: "Invalid Ethereum address" }, { status: 400 });
    }

    // Verify the stateless challenge nonce (HMAC-signed, works across instances)
    const nonce = await consumeChallenge(checksummed, clientNonce);
    if (!nonce) {
      return NextResponse.json(
        { error: "Invalid or expired challenge. Call /api/auth/connect first." },
        { status: 401 },
      );
    }

    // Recover signer from the signature
    const recovered = recoverAddress(nonce, signature);
    if (!recovered || recovered !== checksummed.toLowerCase()) {
      return NextResponse.json(
        { error: "Signature verification failed" },
        { status: 401 },
      );
    }

    // Parse scope options
    const scope: SessionScope = {};
    if (rawScope && typeof rawScope === "object") {
      if (rawScope.role && ["genius", "idiot", "both"].includes(rawScope.role)) {
        scope.role = rawScope.role;
      }
      if (typeof rawScope.max_spend_usdc === "number" && rawScope.max_spend_usdc > 0) {
        scope.maxSpendUsdc = rawScope.max_spend_usdc;
      }
      if (typeof rawScope.expires_in_hours === "number" && rawScope.expires_in_hours > 0) {
        scope.expiresInHours = Math.min(rawScope.expires_in_hours, 24);
      }
    }

    const { token, expiresAt } = await createSessionToken(checksummed, scope);

    return NextResponse.json({
      session_token: token,
      expires_at: new Date(expiresAt).toISOString(),
      scope: {
        role: scope.role ?? "both",
        max_spend_usdc: scope.maxSpendUsdc ?? null,
      },
    });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}
