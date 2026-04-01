import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { discoverMetagraph, isPublicIp } from "@/lib/bt-metagraph";

/**
 * POST /api/genius/signal/commit
 *
 * Distributes Shamir key shares to validators after the client has already
 * committed the signal on-chain. The API never sees plaintext picks.
 *
 * Body:
 *   encrypted_blob   - hex-encoded encrypted signal blob
 *   commit_hash      - bytes32 commit hash (matches on-chain)
 *   shares           - array of { validator_uid, key_share, index_share, share_x }
 *   commit_tx_hash   - the on-chain commit transaction hash
 *   event_id         - event identifier
 *   sport            - sport key (e.g. "basketball_nba")
 *   fee_bps          - fee in basis points
 *   sla_multiplier_bps - SLA multiplier in basis points
 *   max_notional_usdc  - max notional in USDC (human-readable)
 *   expires_at       - ISO 8601 expiry timestamp
 *   shamir_threshold - minimum shares needed to reconstruct
 */

const RATE_LIMIT_MAX = 30;

interface SharePayload {
  validator_uid: number;
  // Accept both SDK-style and validator-style field names
  key_share?: string;
  index_share?: string;
  share_x?: number;
  share_y?: string;
  encrypted_key_share?: string;
  encrypted_index_share?: string;
}

interface CommitBody {
  encrypted_blob: string;
  commit_hash: string;
  shares: SharePayload[];
  commit_tx_hash: string;
  event_id: string;
  sport: string;
  fee_bps: number;
  sla_multiplier_bps: number;
  max_notional_usdc: number;
  expires_at: string;
  shamir_threshold: number;
}

export async function POST(request: NextRequest) {
  if (isRateLimited("genius-signal-commit", getIp(request), RATE_LIMIT_MAX)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  let body: CommitBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  // Validate required fields
  const {
    encrypted_blob,
    commit_hash,
    shares,
    commit_tx_hash,
    event_id,
    sport,
    fee_bps,
    sla_multiplier_bps,
    max_notional_usdc,
    expires_at,
    shamir_threshold,
  } = body;

  if (!encrypted_blob || !commit_hash || !commit_tx_hash || !event_id || !sport || !expires_at) {
    return NextResponse.json(
      { error: "missing_fields", message: "encrypted_blob, commit_hash, commit_tx_hash, event_id, sport, and expires_at are required" },
      { status: 400 },
    );
  }

  if (!Array.isArray(shares) || shares.length === 0) {
    return NextResponse.json(
      { error: "missing_shares", message: "At least one share is required" },
      { status: 400 },
    );
  }

  if (typeof fee_bps !== "number" || fee_bps < 0) {
    return NextResponse.json(
      { error: "invalid_fee", message: "fee_bps must be a non-negative number" },
      { status: 400 },
    );
  }

  if (typeof sla_multiplier_bps !== "number" || sla_multiplier_bps < 0) {
    return NextResponse.json(
      { error: "invalid_sla", message: "sla_multiplier_bps must be a non-negative number" },
      { status: 400 },
    );
  }

  if (typeof max_notional_usdc !== "number" || max_notional_usdc <= 0) {
    return NextResponse.json(
      { error: "invalid_notional", message: "max_notional_usdc must be a positive number" },
      { status: 400 },
    );
  }

  if (typeof shamir_threshold !== "number" || shamir_threshold < 1) {
    return NextResponse.json(
      { error: "invalid_threshold", message: "shamir_threshold must be at least 1" },
      { status: 400 },
    );
  }

  // Discover validators from the metagraph
  const { nodes } = await discoverMetagraph();
  const validatorsByUid = new Map(
    nodes
      .filter((n) => n.isValidator && n.port > 0 && isPublicIp(n.ip))
      .map((n) => [n.uid, `http://${n.ip}:${n.port}`]),
  );

  // Distribute shares to validators in parallel
  const results = await Promise.allSettled(
    shares.map(async (share) => {
      const url = validatorsByUid.get(share.validator_uid);
      if (!url) {
        return { uid: share.validator_uid, success: false as const, reason: "not_found" };
      }

      try {
        // Derive a validator-friendly signal_id from the tx hash
        // Validators expect alphanumeric/hyphens, max 256 chars
        const signalIdStr = commit_tx_hash.replace(/^0x/, "").slice(0, 64);

        // Normalize field names: accept both SDK-style and validator-style
        const shareY = share.share_y || share.key_share || "";
        const encKeyShare = share.encrypted_key_share || share.index_share || shareY;
        const encIndexShare = share.encrypted_index_share || share.index_share || "";

        const resp = await fetch(`${url}/v1/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal_id: signalIdStr,
            genius_address: auth.address,
            share_x: share.share_x ?? 1,
            share_y: shareY,
            encrypted_key_share: encKeyShare,
            encrypted_index_share: encIndexShare,
            shamir_threshold,
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return { uid: share.validator_uid, success: false as const, reason: `HTTP ${resp.status}: ${text}` };
        }

        return { uid: share.validator_uid, success: true as const, reason: "" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { uid: share.validator_uid, success: false as const, reason: message };
      }
    }),
  );

  const received: number[] = [];
  const failed: { uid: number; reason: string }[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const val = result.value;
      if (val.success) {
        received.push(val.uid);
      } else {
        failed.push({ uid: val.uid, reason: val.reason });
      }
    } else {
      failed.push({ uid: -1, reason: result.reason?.message || "unknown" });
    }
  }

  // Signal ID is derived from the commit_tx_hash (client already knows it)
  const signal_id = commit_tx_hash;

  if (received.length === 0) {
    return NextResponse.json(
      {
        error: "share_distribution_failed",
        message: "No validators accepted shares",
        signal_id,
        validators_received_shares: 0,
        validators_total: shares.length,
        failures: failed,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    signal_id,
    status: "active",
    validators_received_shares: received.length,
    validators_total: shares.length,
    validators_accepted: received,
    ...(failed.length > 0 ? { validators_failed: failed } : {}),
  });
}
