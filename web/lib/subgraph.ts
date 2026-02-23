/**
 * Subgraph query client for the Djinn Protocol.
 *
 * Uses plain fetch (no library dependency) to query The Graph's hosted
 * service or a local Graph node. Falls back gracefully when the subgraph
 * URL is not configured.
 */

const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || "";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface SubgraphGeniusEntry {
  id: string;
  totalSignals: string;
  activeSignals: string;
  totalPurchases: string;
  totalVolume: string;
  totalFeesEarned: string;
  aggregateQualityScore: string;
  totalAudits: string;
  collateralDeposited: string;
  totalSlashed: string;
  totalTrackRecordProofs: string;
  totalFavorable?: string;
  totalUnfavorable?: string;
  totalVoid?: string;
}

export interface SubgraphTrackRecordProof {
  id: string;
  signalCount: string;
  totalGain: string;
  totalLoss: string;
  favCount: string;
  unfavCount: string;
  voidCount: string;
  proofHash: string;
  submittedAt: string;
}

export interface SubgraphProtocolStats {
  totalSignals: string;
  totalPurchases: string;
  totalVolume: string;
  totalAudits: string;
  uniqueGeniuses: string;
  uniqueIdiots: string;
  totalTrackRecordProofs: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function querySubgraph<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  if (!SUBGRAPH_URL) return null;

  try {
    const resp = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!resp.ok) {
      console.warn(`Subgraph query failed: ${resp.status}`);
      return null;
    }

    const json: GraphQLResponse<T> = await resp.json();
    if (json.errors?.length) {
      console.warn("Subgraph errors:", json.errors);
      return null;
    }

    return json.data ?? null;
  } catch (err) {
    console.warn("Subgraph query network error:", err);
    return null;
  }
}

/** Check if the subgraph is configured */
export function isSubgraphConfigured(): boolean {
  return SUBGRAPH_URL.length > 0;
}

/** Fetch the leaderboard: top geniuses sorted by aggregate quality score */
export async function fetchLeaderboard(
  limit = 50,
): Promise<SubgraphGeniusEntry[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = await querySubgraph<{ geniuses: SubgraphGeniusEntry[] }>(`{
    geniuses(
      first: ${safeLimit}
      orderBy: aggregateQualityScore
      orderDirection: desc
      where: { totalAudits_gt: "0" }
    ) {
      id
      totalSignals
      activeSignals
      totalPurchases
      totalVolume
      totalFeesEarned
      aggregateQualityScore
      totalAudits
      collateralDeposited
      totalSlashed
      totalTrackRecordProofs
      totalFavorable
      totalUnfavorable
      totalVoid
    }
  }`);

  return result?.geniuses ?? [];
}

/** Fetch track record proofs for a specific genius */
export async function fetchTrackRecordProofs(
  geniusAddress: string,
): Promise<SubgraphTrackRecordProof[]> {
  if (!ETH_ADDRESS_RE.test(geniusAddress)) return [];

  const result = await querySubgraph<{
    trackRecordProofs: SubgraphTrackRecordProof[];
  }>(
    `query($genius: String!) {
      trackRecordProofs(
        where: { genius: $genius }
        orderBy: submittedAt
        orderDirection: desc
        first: 50
      ) {
        id
        signalCount
        totalGain
        totalLoss
        favCount
        unfavCount
        voidCount
        proofHash
        submittedAt
      }
    }`,
    { genius: geniusAddress.toLowerCase() },
  );

  return result?.trackRecordProofs ?? [];
}

// ---------------------------------------------------------------------------
// Genius signal queries (for track record proof auto-population)
// ---------------------------------------------------------------------------

export interface SubgraphSignalPurchase {
  id: string;
  onChainPurchaseId: string;
  notional: string;
  feePaid: string;
  outcome: string; // "Pending" | "Favorable" | "Unfavorable" | "Void"
  purchasedAt: string;
}

export interface SubgraphSignal {
  id: string;
  sport: string;
  maxPriceBps: string;
  slaMultiplierBps: string;
  status: string; // "Active" | "Cancelled" | "Settled"
  createdAt: string;
  purchases: SubgraphSignalPurchase[];
}

/** Fetch a genius's signals with their purchase data (for track record proofs) */
export async function fetchGeniusSignals(
  geniusAddress: string,
  limit = 100,
): Promise<SubgraphSignal[]> {
  if (!ETH_ADDRESS_RE.test(geniusAddress)) return [];

  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = await querySubgraph<{ signals: SubgraphSignal[] }>(
    `query($genius: String!, $limit: Int!) {
      signals(
        where: { genius: $genius }
        orderBy: createdAt
        orderDirection: desc
        first: $limit
      ) {
        id
        sport
        maxPriceBps
        slaMultiplierBps
        status
        createdAt
        purchases(first: 10) {
          id
          onChainPurchaseId
          notional
          feePaid
          outcome
          purchasedAt
        }
      }
    }`,
    { genius: geniusAddress.toLowerCase(), limit: safeLimit },
  );

  return result?.signals ?? [];
}

/** Fetch protocol-wide statistics */
export async function fetchProtocolStats(): Promise<SubgraphProtocolStats | null> {
  const result = await querySubgraph<{
    protocolStats: SubgraphProtocolStats;
  }>(`{
    protocolStats(id: "1") {
      totalSignals
      totalPurchases
      totalVolume
      totalAudits
      uniqueGeniuses
      uniqueIdiots
      totalTrackRecordProofs
    }
  }`);

  return result?.protocolStats ?? null;
}

// ---------------------------------------------------------------------------
// Admin activity queries — recent on-chain events for the Protocol tab
// ---------------------------------------------------------------------------

export interface SubgraphRecentSignal {
  id: string;
  genius: { id: string };
  sport: string;
  status: string;
  maxPriceBps: string;
  createdAt: string;
  createdAtTx: string;
}

export interface SubgraphRecentPurchase {
  id: string;
  signal: { id: string; sport: string };
  idiot: { id: string };
  genius: { id: string };
  notional: string;
  feePaid: string;
  outcome: string;
  purchasedAt: string;
  purchasedAtTx: string;
}

export interface SubgraphRecentAudit {
  id: string;
  genius: { id: string };
  idiot: { id: string };
  cycle: string;
  qualityScore: string;
  trancheA: string;
  trancheB: string;
  protocolFee: string;
  isEarlyExit: boolean;
  settledAt: string;
  settledAtTx: string;
}

export interface SubgraphRecentTrackRecord {
  id: string;
  genius: { id: string };
  signalCount: string;
  totalGain: string;
  totalLoss: string;
  favCount: string;
  unfavCount: string;
  voidCount: string;
  submittedAt: string;
  submittedAtTx: string;
}

/** Fetch recent signals across all geniuses (newest first) */
export async function fetchRecentSignals(
  limit = 50,
): Promise<SubgraphRecentSignal[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await querySubgraph<{ signals: SubgraphRecentSignal[] }>(`{
    signals(first: ${safeLimit}, orderBy: createdAt, orderDirection: desc) {
      id
      genius { id }
      sport
      status
      maxPriceBps
      createdAt
      createdAtTx
    }
  }`);
  return result?.signals ?? [];
}

/** Fetch recent purchases across all idiots (newest first) */
export async function fetchRecentPurchases(
  limit = 50,
): Promise<SubgraphRecentPurchase[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await querySubgraph<{ purchases: SubgraphRecentPurchase[] }>(`{
    purchases(first: ${safeLimit}, orderBy: purchasedAt, orderDirection: desc) {
      id
      signal { id sport }
      idiot { id }
      genius { id }
      notional
      feePaid
      outcome
      purchasedAt
      purchasedAtTx
    }
  }`);
  return result?.purchases ?? [];
}

/** Fetch recent audit settlements (newest first) */
export async function fetchRecentAudits(
  limit = 50,
): Promise<SubgraphRecentAudit[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await querySubgraph<{ auditResults: SubgraphRecentAudit[] }>(`{
    auditResults(first: ${safeLimit}, orderBy: settledAt, orderDirection: desc) {
      id
      genius { id }
      idiot { id }
      cycle
      qualityScore
      trancheA
      trancheB
      protocolFee
      isEarlyExit
      settledAt
      settledAtTx
    }
  }`);
  return result?.auditResults ?? [];
}

/** Fetch recent track record proof submissions (newest first) */
export async function fetchRecentTrackRecordProofs(
  limit = 50,
): Promise<SubgraphRecentTrackRecord[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await querySubgraph<{
    trackRecordProofs: SubgraphRecentTrackRecord[];
  }>(`{
    trackRecordProofs(first: ${safeLimit}, orderBy: submittedAt, orderDirection: desc) {
      id
      genius { id }
      signalCount
      totalGain
      totalLoss
      favCount
      unfavCount
      voidCount
      submittedAt
      submittedAtTx
    }
  }`);
  return result?.trackRecordProofs ?? [];
}
