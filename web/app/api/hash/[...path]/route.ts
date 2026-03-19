import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";

/**
 * GET /hash/<anything>
 *
 * Returns the SHA-256 hash of the path. The content is deterministic:
 * anyone who knows the path can compute the expected hash. Used for
 * TLSNotary nonce challenges where the validator needs to verify that
 * the proof contains the correct content without trusting the prover.
 *
 * Example:
 *   GET /hash/djinn-nonce-a1b2c3d4
 *   -> { "input": "djinn-nonce-a1b2c3d4", "sha256": "e3b0c44..." }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const input = path.join("/");
  const hash = createHash("sha256").update(input).digest("hex");
  return NextResponse.json(
    { input, sha256: hash },
    {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  );
}
