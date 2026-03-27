import Link from "next/link";

export const metadata = {
  title: "API Reference | Djinn Docs",
  description:
    "REST API for Djinn: genius signal creation, idiot purchases, track records, and settlement status. Programmatic access to the sports intelligence marketplace.",
};

interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  description: string;
  auth?: boolean;
  params?: { name: string; type: string; description: string; required?: boolean }[];
  response?: string;
}

const geniusEndpoints: Endpoint[] = [
  {
    method: "POST",
    path: "/api/genius/signal/prepare",
    description:
      "Prepare a new signal. Returns validator public keys and parameters needed for client-side encryption and Shamir splitting. The actual pick is never sent to the server.",
    auth: true,
    params: [
      { name: "sport", type: "string", description: "Sport key (e.g., basketball_nba)", required: true },
      { name: "event_id", type: "string", description: "The Odds API event ID", required: true },
      { name: "max_notional_usdc", type: "number", description: "Maximum total purchase amount", required: true },
      { name: "sla_multiplier_bps", type: "integer", description: "SLA penalty multiplier in basis points (10000 = 1x)" },
      { name: "fee_bps", type: "integer", description: "Fee charged to buyers in basis points (500 = 5%)" },
      { name: "expires_at", type: "string", description: "ISO 8601 expiry (before game start)" },
    ],
    response: `{
  "validator_pubkeys": ["0x...", "0x..."],
  "commit_params": { "chain_id": 8453, "contract": "0x4712..." },
  "suggested_decoys": ["Over 218.5 (-110)", "Under 218.5 (-110)", ...],
  "shamir_n": 10,
  "shamir_k": 3
}`,
  },
  {
    method: "POST",
    path: "/api/genius/signal/commit",
    description:
      "Submit the encrypted signal blob and Shamir shares after client-side encryption. Distributes shares to validators.",
    auth: true,
    params: [
      { name: "encrypted_blob", type: "string", description: "Hex-encoded encrypted signal blob", required: true },
      { name: "commit_hash", type: "string", description: "Keccak256 hash of the blob", required: true },
      { name: "encrypted_shares", type: "object[]", description: "Per-validator encrypted key and index shares", required: true },
      { name: "commit_tx_hash", type: "string", description: "On-chain commit transaction hash", required: true },
    ],
    response: `{
  "signal_id": "0xa3f...",
  "status": "active",
  "validators_received": 4,
  "validators_total": 4
}`,
  },
  {
    method: "GET",
    path: "/api/genius/signals",
    description: "List all signals for the authenticated genius.",
    auth: true,
    params: [
      { name: "status", type: "string", description: "Filter: active, expired, cancelled, settled" },
      { name: "sport", type: "string", description: "Filter by sport key" },
      { name: "limit", type: "integer", description: "Max results (default 20)" },
      { name: "offset", type: "integer", description: "Pagination offset" },
    ],
    response: `{
  "signals": [
    {
      "signal_id": "0xa3f...",
      "sport": "basketball_nba",
      "status": "active",
      "created_at": "2026-03-27T18:00:00Z",
      "expires_at": "2026-03-28T00:00:00Z",
      "purchases": 3,
      "total_notional": 750,
      "fees_earned": 37.50
    }
  ],
  "total": 1
}`,
  },
  {
    method: "DELETE",
    path: "/api/genius/signal/{signal_id}",
    description: "Cancel an active signal. Refunds unreleased escrow to buyers.",
    auth: true,
    response: `{
  "signal_id": "0xa3f...",
  "status": "cancelled",
  "cancel_tx_hash": "0x..."
}`,
  },
  {
    method: "GET",
    path: "/api/genius/earnings",
    description: "Summary of fees earned, collateral status, and settlement history.",
    auth: true,
    response: `{
  "total_fees_earned_usdc": 1250.00,
  "claimable_fees_usdc": 375.00,
  "collateral_deposited_usdc": 8000.00,
  "collateral_locked_usdc": 3500.00,
  "quality_score_30d": 0.72,
  "signals_settled": 14,
  "signals_active": 3
}`,
  },
  {
    method: "POST",
    path: "/api/genius/claim",
    description: "Claim all available fees (subject to 48-hour post-settlement delay).",
    auth: true,
    response: `{
  "claimed_usdc": 375.00,
  "claim_tx_hash": "0x...",
  "next_claimable_at": "2026-03-29T14:00:00Z"
}`,
  },
];

const idiotEndpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/api/idiot/browse",
    description: "Browse available signals with filtering and sorting.",
    params: [
      { name: "sport", type: "string", description: "Filter by sport key" },
      { name: "genius", type: "string", description: "Filter by genius address" },
      { name: "min_quality_score", type: "number", description: "Minimum genius quality score (0-1)" },
      { name: "max_fee_bps", type: "integer", description: "Maximum fee in basis points" },
      { name: "sort", type: "string", description: "Sort: quality_score, fee, expires_soon, notional_remaining" },
      { name: "limit", type: "integer", description: "Max results (default 20)" },
    ],
    response: `{
  "signals": [
    {
      "signal_id": "0xa3f...",
      "genius": "0x68fc...",
      "sport": "basketball_nba",
      "fee_bps": 500,
      "sla_multiplier_bps": 15000,
      "notional_remaining_usdc": 250,
      "genius_quality_score_30d": 0.72,
      "genius_win_rate": 0.64
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/idiot/genius/{address}/profile",
    description: "View a genius's public track record and performance history.",
    response: `{
  "address": "0x68fc...",
  "quality_score_30d": 0.72,
  "total_signals": 47,
  "settled_signals": 44,
  "win_rate": 0.64,
  "sports": ["basketball_nba", "americanfootball_nfl"],
  "recent_settlements": [
    {
      "cycle": 5,
      "quality_score": 1250,
      "favorable": 7,
      "unfavorable": 2,
      "void": 1
    }
  ]
}`,
  },
  {
    method: "POST",
    path: "/api/idiot/purchase",
    description:
      "Purchase a signal. Triggers MPC availability check, escrow debit, and encrypted key share release. The real pick must be available at a sportsbook.",
    auth: true,
    params: [
      { name: "signal_id", type: "string", description: "The signal ID to purchase", required: true },
      { name: "notional_usdc", type: "number", description: "Amount in USDC to commit", required: true },
    ],
    response: `{
  "purchase_id": 42,
  "signal_id": "0xa3f...",
  "available": true,
  "sportsbooks": ["DraftKings", "FanDuel"],
  "encrypted_key_shares": ["0x...", "0x..."],
  "purchase_tx_hash": "0x..."
}`,
  },
  {
    method: "GET",
    path: "/api/idiot/purchases",
    description: "List all purchases with outcomes.",
    auth: true,
    params: [
      { name: "status", type: "string", description: "Filter: pending, settled, void" },
      { name: "limit", type: "integer", description: "Max results (default 20)" },
    ],
    response: `{
  "purchases": [
    {
      "purchase_id": 42,
      "signal_id": "0xa3f...",
      "genius": "0x68fc...",
      "notional_usdc": 200,
      "outcome": "favorable",
      "settled_at": "2026-03-28T06:00:00Z"
    }
  ]
}`,
  },
  {
    method: "GET",
    path: "/api/idiot/balance",
    description: "Escrow balance, locked funds, and transaction history.",
    auth: true,
    response: `{
  "escrow_balance_usdc": 2500.00,
  "locked_in_purchases_usdc": 400.00,
  "available_usdc": 2100.00,
  "net_pnl_usdc": 340.00
}`,
  },
];

const sharedEndpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/api/odds",
    description: "Current odds from The Odds API. No authentication required.",
    params: [
      { name: "sport", type: "string", description: "Sport key (e.g., basketball_nba)", required: true },
    ],
  },
  {
    method: "GET",
    path: "/api/sports",
    description: "List all supported sports with their keys.",
  },
  {
    method: "GET",
    path: "/api/network/status",
    description: "Network health: active validators, miner count, attestation rate.",
  },
  {
    method: "GET",
    path: "/api/settlement/{genius}/{idiot}/status",
    description: "Settlement status for a genius-idiot pair.",
    response: `{
  "current_cycle": 3,
  "signals_in_cycle": 7,
  "signals_resolved": 5,
  "ready_for_settlement": false
}`,
  },
];

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-green-100 text-green-700",
    POST: "bg-blue-100 text-blue-700",
    DELETE: "bg-red-100 text-red-700",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-bold ${colors[method] || "bg-slate-100 text-slate-700"}`}>
      {method}
    </span>
  );
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-3">
        <MethodBadge method={endpoint.method} />
        <code className="text-sm font-mono text-slate-900">{endpoint.path}</code>
        {endpoint.auth && (
          <span className="ml-auto text-xs text-slate-400 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            Auth
          </span>
        )}
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-slate-600 mb-3">{endpoint.description}</p>

        {endpoint.params && endpoint.params.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Parameters</p>
            <div className="space-y-1.5">
              {endpoint.params.map((p) => (
                <div key={p.name} className="flex items-baseline gap-2 text-sm">
                  <code className="text-xs font-mono text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded">
                    {p.name}
                  </code>
                  <span className="text-xs text-slate-400">{p.type}</span>
                  {p.required && <span className="text-xs text-red-400">required</span>}
                  <span className="text-xs text-slate-500">{p.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {endpoint.response && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Response</p>
            <pre className="text-xs font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto">
              {endpoint.response}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ApiDocs() {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-slate-900 mb-3">API Reference</h1>
      <p className="text-lg text-slate-500 mb-4">
        REST API for programmatic access to the Djinn protocol. All amounts are in
        plain USDC (not wei). All timestamps are ISO 8601.
      </p>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-10">
        <p className="text-sm text-amber-800">
          <strong>Base URL:</strong>{" "}
          <code className="bg-amber-100 px-1.5 py-0.5 rounded text-xs font-mono">
            https://djinn.gg/api
          </code>
        </p>
        <p className="text-sm text-amber-700 mt-1">
          Rate limit: 200 requests per minute per IP. Authenticated endpoints require a
          wallet signature session token.
        </p>
      </div>

      {/* Authentication section */}
      <div className="mb-12">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">Authentication</h2>
        <p className="text-sm text-slate-600 mb-4">
          Endpoints marked with a lock icon require authentication. Connect your wallet
          and sign a challenge to receive a session token. Include it in the
          Authorization header.
        </p>
        <pre className="text-xs font-mono bg-slate-900 text-green-400 rounded-lg p-3 overflow-x-auto mb-4">
{`// 1. Request a challenge
POST /api/auth/connect
{ "address": "0x68fc..." }

// 2. Sign and verify
POST /api/auth/verify
{ "address": "0x68fc...", "signature": "0x..." }

// 3. Use the session token
GET /api/genius/signals
Authorization: Bearer djn_...`}
        </pre>
      </div>

      {/* Genius endpoints */}
      <div className="mb-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-full bg-genius-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-genius-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">Genius Endpoints</h2>
        </div>
        <div className="space-y-4">
          {geniusEndpoints.map((ep) => (
            <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} />
          ))}
        </div>
      </div>

      {/* Idiot endpoints */}
      <div className="mb-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-full bg-idiot-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-idiot-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">Idiot Endpoints</h2>
        </div>
        <div className="space-y-4">
          {idiotEndpoints.map((ep) => (
            <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} />
          ))}
        </div>
      </div>

      {/* Shared endpoints */}
      <div className="mb-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">Public Endpoints</h2>
        </div>
        <div className="space-y-4">
          {sharedEndpoints.map((ep) => (
            <EndpointCard key={`${ep.method}-${ep.path}`} endpoint={ep} />
          ))}
        </div>
      </div>

      {/* Important note about encryption */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-4 mb-8">
        <h3 className="font-semibold text-slate-900 mb-2">Client-side encryption</h3>
        <p className="text-sm text-slate-600">
          The Genius signal creation flow requires client-side encryption. The API never
          sees plaintext picks. Use the{" "}
          <Link href="/docs/sdk" className="text-slate-900 underline font-medium">
            Djinn SDK
          </Link>{" "}
          to handle encryption, decoy generation, and Shamir splitting locally before
          calling the <code className="text-xs bg-slate-200 px-1 rounded">/api/genius/signal/commit</code>{" "}
          endpoint.
        </p>
      </div>

      <div className="mt-8 pb-4">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>
    </div>
  );
}
