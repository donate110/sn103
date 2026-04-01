import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { authenticateRequest } from "@/lib/api-auth";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";
import { ADDRESSES, ESCROW_ABI } from "@/lib/contracts";

/**
 * GET /api/idiot/purchases
 *
 * Auth required. Lists all purchases for the authenticated idiot by querying
 * SignalPurchased events from the Escrow contract, then enriching each with
 * its current outcome from getPurchase().
 *
 * Query params:
 *   status  - Filter: pending | settled | void (optional)
 *   limit   - Max results (default 20, max 100)
 *   offset  - Pagination offset (default 0)
 *
 * Response: { purchases: [...], total, offset, limit }
 */

const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const DEPLOY_BLOCK = Number(process.env.NEXT_PUBLIC_DEPLOY_BLOCK ?? "0");
const CHUNK_SIZE = 9_999;
const MAX_LIMIT = 100;

// Outcome enum from the Escrow contract
const OUTCOME_LABELS: Record<number, string> = {
  0: "pending",
  1: "favorable",
  2: "unfavorable",
  3: "void",
};

function outcomeToStatus(outcome: number): string {
  if (outcome === 0) return "pending";
  if (outcome === 3) return "void";
  return "settled"; // favorable or unfavorable are both "settled"
}

export async function GET(request: NextRequest) {
  if (isRateLimited("idiot-purchases", getIp(request), 30)) {
    return rateLimitResponse();
  }

  const auth = await authenticateRequest(request);
  if (!auth) {
    return NextResponse.json(
      { error: "unauthorized", message: "Valid session token required" },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status"); // pending | settled | void
  const limit = Math.min(
    Math.max(1, parseInt(searchParams.get("limit") || "20", 10)),
    MAX_LIMIT,
  );
  const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10));

  if (
    statusFilter &&
    !["pending", "settled", "void"].includes(statusFilter)
  ) {
    return NextResponse.json(
      {
        error: "invalid_status",
        message: "status must be one of: pending, settled, void",
      },
      { status: 400 },
    );
  }

  if (ADDRESSES.escrow === "0x0000000000000000000000000000000000000000") {
    return NextResponse.json({ purchases: [], total: 0, offset, limit });
  }

  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const escrowContract = new ethers.Contract(
      ADDRESSES.escrow,
      ESCROW_ABI,
      provider,
    );

    const buyerAddress = ethers.getAddress(auth.address);

    // Query SignalPurchased events where buyer = authenticated address
    // Event: SignalPurchased(uint256 indexed signalId, address indexed buyer, uint256 purchaseId, ...)
    const filter = escrowContract.filters.SignalPurchased(null, buyerAddress);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(DEPLOY_BLOCK, 0);

    // Chunk the query to avoid RPC limits
    const chunkRanges: [number, number][] = [];
    for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE) {
      chunkRanges.push([
        start,
        Math.min(start + CHUNK_SIZE - 1, currentBlock),
      ]);
    }

    const events: (ethers.EventLog | ethers.Log)[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < chunkRanges.length; i += CONCURRENCY) {
      const batch = chunkRanges.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(([start, end]) =>
          escrowContract.queryFilter(filter, start, end),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          events.push(...result.value);
        }
      }
    }

    // Process events newest-first
    events.reverse();

    // Enrich each purchase with on-chain outcome data
    interface PurchaseRecord {
      purchase_id: number;
      signal_id: string;
      notional_usdc: number;
      fee_usdc: number;
      credit_used_usdc: number;
      usdc_paid: number;
      outcome: string;
      status: string;
      purchased_at: string;
    }

    const enrichPromises = events.map(
      async (event): Promise<PurchaseRecord | null> => {
        const args = (event as ethers.EventLog).args;
        if (!args) return null;

        const purchaseId = Number(args.purchaseId);
        const signalId = args.signalId.toString();
        const notional = Number(args.notional) / 1e6;
        const feePaid = Number(args.feePaid) / 1e6;
        const creditUsed = Number(args.creditUsed) / 1e6;
        const usdcPaid = Number(args.usdcPaid) / 1e6;

        // Get current outcome from the contract
        let outcome = 0;
        let purchasedAtUnix = 0;
        try {
          const purchaseData = await escrowContract.getPurchase(purchaseId);
          outcome = Number(purchaseData.outcome);
          purchasedAtUnix = Number(purchaseData.purchasedAt);
        } catch {
          // If getPurchase fails, use event block timestamp as fallback
          try {
            const block = await provider.getBlock(event.blockNumber);
            purchasedAtUnix = block?.timestamp ?? 0;
          } catch {
            // non-critical
          }
        }

        const status = outcomeToStatus(outcome);

        // Apply status filter
        if (statusFilter && status !== statusFilter) return null;

        return {
          purchase_id: purchaseId,
          signal_id: signalId,
          notional_usdc: notional,
          fee_usdc: feePaid,
          credit_used_usdc: creditUsed,
          usdc_paid: usdcPaid,
          outcome: OUTCOME_LABELS[outcome] ?? "unknown",
          status,
          purchased_at: purchasedAtUnix
            ? new Date(purchasedAtUnix * 1000).toISOString()
            : "",
        };
      },
    );

    const enriched = await Promise.all(enrichPromises);
    const allPurchases = enriched.filter(
      (p): p is PurchaseRecord => p !== null,
    );

    const total = allPurchases.length;
    const paged = allPurchases.slice(offset, offset + limit);

    return NextResponse.json({
      purchases: paged,
      total,
      offset,
      limit,
    });
  } catch (error) {
    console.error("purchases_error", error);
    return NextResponse.json(
      { error: "internal_error", message: "Failed to fetch purchases" },
      { status: 500 },
    );
  }
}
