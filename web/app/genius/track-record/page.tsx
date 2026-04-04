"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useAuditHistory } from "@/lib/hooks/useAuditHistory";
import { formatUsdc, truncateAddress } from "@/lib/types";

export default function TrackRecordPage() {
  const { isConnected, address } = useAccount();
  const router = useRouter();
  const { audits, loading, error, aggregateQualityScore } = useAuditHistory(address);

  // Compute aggregate stats from on-chain audit settlements
  const stats = useMemo(() => {
    const totalCycles = audits.length;
    const totalTrancheA = audits.reduce((sum, a) => sum + a.trancheA, 0n);
    const totalTrancheB = audits.reduce((sum, a) => sum + a.trancheB, 0n);
    const totalFees = audits.reduce((sum, a) => sum + a.protocolFee, 0n);
    const earlyExits = audits.filter((a) => a.isEarlyExit).length;
    const profitable = audits.filter((a) => a.qualityScore > 0n).length;
    const uniqueIdiots = new Set(audits.map((a) => a.idiot.toLowerCase())).size;

    return {
      totalCycles,
      profitable,
      earlyExits,
      uniqueIdiots,
      totalTrancheA,
      totalTrancheB,
      totalFees,
    };
  }, [audits]);

  if (!isConnected) {
    return (
      <div className="text-center py-20">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Track Record
        </h1>
        <p className="text-slate-500">
          Connect your wallet to view your track record.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <button
        onClick={() => router.push("/genius")}
        className="text-sm text-slate-500 hover:text-slate-900 mb-6 transition-colors"
      >
        &larr; Back to Dashboard
      </button>

      <h1 className="text-3xl font-bold text-slate-900 mb-2">
        Track Record
      </h1>
      <p className="text-slate-500 mb-8">
        Your on-chain settlement history across all audit sets. These results
        are finalized by validator consensus and publicly verifiable on Base.
      </p>

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block w-6 h-6 border-2 border-genius-500 border-t-transparent rounded-full animate-spin mb-2" />
          <p className="text-xs text-slate-500">Loading audit history...</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 mb-6" role="alert">
          <p className="text-xs text-red-600">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-6">
          {/* Aggregate stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="card text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Audit Sets</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{stats.totalCycles}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Profitable</p>
              <p className="text-2xl font-bold text-green-600 mt-1">
                {stats.totalCycles > 0
                  ? `${Math.round((stats.profitable / stats.totalCycles) * 100)}%`
                  : "—"}
              </p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Quality Score</p>
              <p className={`text-2xl font-bold mt-1 ${aggregateQualityScore >= 0n ? "text-green-600" : "text-red-500"}`}>
                {aggregateQualityScore >= 0n ? "+" : ""}${formatUsdc(aggregateQualityScore < 0n ? -aggregateQualityScore : aggregateQualityScore)}
              </p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Unique Buyers</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{stats.uniqueIdiots}</p>
            </div>
          </div>

          {/* Settlement history */}
          <div className="card">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Settlement History
            </h2>

            {audits.length === 0 ? (
              <p className="text-center text-slate-500 py-8">
                No settled audit sets yet. Settlements occur once enough signals
                with each buyer are resolved by validator consensus.
              </p>
            ) : (
              <div className="space-y-3 max-h-[600px] overflow-y-auto">
                {audits.map((audit, i) => (
                  <div
                    key={`${audit.genius}-${audit.idiot}-${audit.cycle.toString()}`}
                    className="flex items-center justify-between rounded-lg px-4 py-3 bg-slate-50 border border-slate-200"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-800">
                          Batch {audit.cycle.toString()}
                        </span>
                        <span className="text-[10px] bg-slate-200 text-slate-500 rounded px-1.5 py-0.5">
                          {truncateAddress(audit.idiot)}
                        </span>
                        {audit.isEarlyExit && (
                          <span className="text-[10px] bg-amber-100 text-amber-600 rounded px-1.5 py-0.5">
                            Early Exit
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                        <span>Block #{audit.blockNumber}</span>
                        <span>Tranche A: ${formatUsdc(audit.trancheA)}</span>
                        {audit.trancheB > 0n && (
                          <span>Tranche B: ${formatUsdc(audit.trancheB)}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-bold ${audit.qualityScore >= 0n ? "text-green-600" : "text-red-500"}`}>
                        {audit.qualityScore >= 0n ? "+" : "-"}${formatUsdc(audit.qualityScore < 0n ? -audit.qualityScore : audit.qualityScore)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* How it works */}
          <div className="card">
            <h3 className="text-sm font-medium text-slate-900 mb-3">
              How It Works
            </h3>
            <ol className="text-sm text-slate-500 space-y-2 list-decimal list-inside">
              <li>
                Purchases between you and a buyer accumulate in a queue. Once
                enough outcomes are resolved, validators can audit a batch.
              </li>
              <li>
                Validators independently resolve game outcomes from public
                ESPN data and reach 2/3+ consensus.
              </li>
              <li>
                A batch MPC computation determines aggregate results without
                revealing which of your lines per signal were real.
              </li>
              <li>
                Settlement is finalized on-chain. Your track record is the
                public sum of all finalized audit batches.
              </li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
