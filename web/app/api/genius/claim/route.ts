import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { AUDIT_ABI } from "@/lib/contracts";
import { ethers } from "ethers";

/**
 * POST /api/genius/claim
 *
 * Returns unsigned claim transaction data, or an error if the Audit contract
 * does not expose a claim function (claims are processed automatically during
 * settlement in that case).
 */

const RATE_LIMIT_MAX = 30;

export async function POST(request: NextRequest) {
  if (isRateLimited("genius-claim", getIp(request), RATE_LIMIT_MAX)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  // Check if the Audit ABI contains a claim function
  const iface = new ethers.Interface(AUDIT_ABI);
  const claimFragment = iface.fragments.find(
    (f) => f.type === "function" && (f as ethers.FunctionFragment).name === "claim",
  );

  if (!claimFragment) {
    return NextResponse.json(
      {
        error: "not_available",
        message:
          "The Audit contract does not expose a claim function. " +
          "Fee claims are processed automatically during settlement. " +
          "Earned fees are transferred to genius wallets as part of the AuditSettled flow.",
      },
      { status: 501 },
    );
  }

  // If a claim function exists in the future, we would encode and return it here.
  // This path is reserved for forward compatibility.
  return NextResponse.json(
    {
      error: "not_available",
      message: "Claim function detected but not yet supported by this API version",
    },
    { status: 501 },
  );
}
