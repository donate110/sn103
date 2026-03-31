"use client";

import { useCallback, useState } from "react";
import QualityScore from "@/components/QualityScore";
import { useLeaderboard } from "@/lib/hooks/useLeaderboard";
import { truncateAddress } from "@/lib/types";

type SortField = "qualityScore" | "totalSignals" | "auditCount" | "roi" | "proofCount" | "winRate";

function getWinRate(entry: { favCount: number; unfavCount: number }): number {
  const total = entry.favCount + entry.unfavCount;
  if (total === 0) return 0;
  return (entry.favCount / total) * 100;
}

export default function Leaderboard() {
  const { data, loading, error, configured } = useLeaderboard();
  const [sortBy, setSortBy] = useState<SortField>("qualityScore");
  const [sortDesc, setSortDesc] = useState(true);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  const copyAddress = useCallback((addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 1500);
  }, []);

  const sorted = [...data].sort((a, b) => {
    const multiplier = sortDesc ? -1 : 1;
    if (sortBy === "winRate") {
      return (getWinRate(a) - getWinRate(b)) * multiplier;
    }
    return (a[sortBy] - b[sortBy]) * multiplier;
  });

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDesc(!sortDesc);
    } else {
      setSortBy(field);
      setSortDesc(true);
    }
  };

  const sortIndicator = (field: SortField) => {
    if (sortBy !== field) return "";
    return sortDesc ? " \u2193" : " \u2191";
  };

  const ariaSort = (field: SortField): "ascending" | "descending" | "none" => {
    if (sortBy !== field) return "none";
    return sortDesc ? "descending" : "ascending";
  };

  const sortKeyHandler = (field: SortField) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSort(field);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Genius Leaderboard</h1>
        <p className="text-slate-500 mt-1">
          Geniuses ranked by cryptographically verified track records
        </p>
      </div>

      {!configured && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 mb-6 text-sm text-amber-700">
          The leaderboard is being set up. Check back soon to see Genius rankings.
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 mb-6 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="pb-3 font-medium w-12">#</th>
              <th className="pb-3 font-medium">Genius</th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("qualityScore")}
                onKeyDown={sortKeyHandler("qualityScore")}
                aria-sort={ariaSort("qualityScore")}
                tabIndex={0}
                role="columnheader"
              >
                Quality Score{sortIndicator("qualityScore")}
              </th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("totalSignals")}
                onKeyDown={sortKeyHandler("totalSignals")}
                aria-sort={ariaSort("totalSignals")}
                tabIndex={0}
                role="columnheader"
              >
                Signals{sortIndicator("totalSignals")}
              </th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("auditCount")}
                onKeyDown={sortKeyHandler("auditCount")}
                aria-sort={ariaSort("auditCount")}
                tabIndex={0}
                role="columnheader"
              >
                Audits{sortIndicator("auditCount")}
              </th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("roi")}
                onKeyDown={sortKeyHandler("roi")}
                aria-sort={ariaSort("roi")}
                tabIndex={0}
                role="columnheader"
              >
                ROI{sortIndicator("roi")}
              </th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("proofCount")}
                onKeyDown={sortKeyHandler("proofCount")}
                aria-sort={ariaSort("proofCount")}
                tabIndex={0}
                role="columnheader"
              >
                Proofs{sortIndicator("proofCount")}
              </th>
              <th
                className="pb-3 font-medium cursor-pointer hover:text-slate-900 transition-colors"
                onClick={() => handleSort("winRate")}
                onKeyDown={sortKeyHandler("winRate")}
                aria-sort={ariaSort("winRate")}
                tabIndex={0}
                role="columnheader"
              >
                Win Rate{sortIndicator("winRate")}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <>
                {[1, 2, 3, 4, 5].map((i) => (
                  <tr key={i} className="border-b border-slate-200 animate-pulse">
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-6" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-200 rounded w-24" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-16" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-10" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-10" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-8" /></td>
                    <td className="py-4"><div className="h-4 bg-slate-100 rounded w-20" /></td>
                  </tr>
                ))}
              </>
            ) : sorted.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-slate-500 py-12">
                  No Geniuses with signal activity yet. Rankings will appear
                  once signals are created on-chain.
                </td>
              </tr>
            ) : (
              sorted.map((entry, i) => (
                <tr
                  key={entry.address}
                  className="border-b border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  <td className="py-4 text-slate-500 font-mono">{i + 1}</td>
                  <td className="py-4">
                    <button
                      className="font-mono text-slate-900 hover:text-genius-600 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                      title="Copy full address"
                      onClick={() => copyAddress(entry.address)}
                    >
                      {truncateAddress(entry.address)}
                      {copiedAddr === entry.address ? (
                        <span className="text-[10px] font-sans text-green-600 font-medium">Copied!</span>
                      ) : (
                        <svg className="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      )}
                    </button>
                  </td>
                  <td className="py-4">
                    <QualityScore score={entry.qualityScore} size="sm" />
                  </td>
                  <td className="py-4 text-slate-900">{entry.totalSignals}</td>
                  <td className="py-4 text-slate-900">{entry.auditCount}</td>
                  <td className="py-4">
                    <span
                      className={
                        entry.roi >= 0 ? "text-green-600" : "text-red-600"
                      }
                    >
                      {entry.roi >= 0 ? "+" : ""}
                      {entry.roi.toFixed(1)}%
                    </span>
                  </td>
                  <td className="py-4 text-slate-900">{entry.proofCount}</td>
                  <td className="py-4">
                    {entry.favCount + entry.unfavCount > 0 ? (
                      <span className="text-slate-900">
                        {getWinRate(entry).toFixed(0)}%
                        <span className="text-xs text-slate-400 ml-1">
                          ({entry.favCount}W/{entry.unfavCount}L{entry.voidCount > 0 ? `/${entry.voidCount}V` : ""})
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Explanation */}
      <div className="mt-8 card">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          How Quality Score Works
        </h2>
        <div className="text-sm text-slate-500 space-y-2">
          <p>
            Quality Score (QS) is the on-chain measure of a Genius&apos;s prediction
            accuracy, computed across each 10-signal audit cycle:
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>
              <span className="text-green-600">Favorable:</span> +Notional &times; (odds &minus; 1)
            </li>
            <li>
              <span className="text-red-600">Unfavorable:</span> &minus;Notional &times; SLA%
            </li>
            <li>
              <span className="text-slate-500">Void:</span> does not count
            </li>
          </ul>
          <p>
            After every 10 signals between a Genius-Idiot pair, a validator
            audit verifies the Quality Score on-chain. If the score is negative, the
            Genius&apos;s collateral is slashed: the Idiot receives a USDC refund
            (up to fees paid) plus Djinn Credits for excess damages.
          </p>
        </div>
      </div>
    </div>
  );
}
