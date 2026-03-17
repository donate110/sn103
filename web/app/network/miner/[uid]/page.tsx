"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";

interface MinerScores {
  validatorUid: number;
  accuracy?: number;
  uptime?: number;
  queries_total?: number;
  queries_correct?: number;
  health_checks_total?: number;
  health_checks_responded?: number;
  attestations_total?: number;
  attestations_valid?: number;
  notary_reliability?: number;
  notary_duties_assigned?: number;
  notary_duties_completed?: number;
  proactive_proof_verified?: boolean;
  lifetime_queries?: number;
  lifetime_correct?: number;
  lifetime_attestations?: number;
  lifetime_attestations_valid?: number;
  weight?: number;
  weight_breakdown?: Record<string, number | boolean | string>;
}

export default function MinerPage() {
  const params = useParams();
  const uid = params.uid as string;
  const [results, setResults] = useState<MinerScores[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/network/miner/${uid}`);
      const data = await res.json();
      if (data.scores?.length > 0) {
        setResults(data.scores);
        setError("");
      } else {
        setError("No validators returned data for this UID.");
      }
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      setError("Failed to load scores.");
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    load();
  }, [load]);

  // Aggregate across validators
  const totalWeight = results.reduce((s, r) => s + (r.weight ?? 0), 0);
  const avgUptime = results.length
    ? results.reduce((s, r) => s + (r.uptime ?? 0), 0) / results.length
    : 0;
  const bestResult = results.reduce(
    (best, r) => ((r.lifetime_queries ?? 0) > (best.lifetime_queries ?? 0) ? r : best),
    results[0] || {},
  );

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-6">
        <Link href="/network" className="text-slate-400 hover:text-slate-600 text-sm">
          Network
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-sm text-slate-600">Miner {uid}</span>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Image src="/djinn-logo.png" alt="Djinn" width={32} height={32} />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Miner UID {uid}</h1>
            <p className="text-sm text-slate-400">
              Scoring data from {results.length} validator{results.length !== 1 ? "s" : ""}.
              {lastUpdate && <> Updated {lastUpdate}.</>}
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {!loading && results.length > 0 && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <div className="card text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Avg Uptime</p>
              <p className="text-2xl font-bold">{(avgUptime * 100).toFixed(1)}%</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Challenges</p>
              <p className="text-2xl font-bold font-mono">
                {bestResult.lifetime_correct ?? 0}/{bestResult.lifetime_queries ?? 0}
              </p>
              <p className="text-[11px] text-slate-400">
                {(bestResult.lifetime_queries ?? 0) > 0
                  ? `${(((bestResult.lifetime_correct ?? 0) / (bestResult.lifetime_queries ?? 1)) * 100).toFixed(0)}% accuracy`
                  : "no data yet"}
              </p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Attestations</p>
              <p className="text-2xl font-bold font-mono">
                {bestResult.lifetime_attestations_valid ?? 0}/{bestResult.lifetime_attestations ?? 0}
              </p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Total Weight</p>
              <p className="text-2xl font-bold font-mono">{totalWeight.toFixed(4)}</p>
              <p className="text-[11px] text-slate-400">sum across {results.length} validators</p>
            </div>
          </div>

          {/* Per-validator detail */}
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Per-Validator Scoring</h2>
          <div className="space-y-4">
            {results.map((r) => (
              <div key={r.validatorUid} className="card">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-mono text-sm font-medium">Validator UID {r.validatorUid}</span>
                  {r.weight !== undefined && (
                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-full font-mono">
                      weight: {r.weight.toFixed(6)}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase">Line Challenges</p>
                    <p className="text-lg font-semibold font-mono">
                      {r.lifetime_correct ?? r.queries_correct ?? 0}/{r.lifetime_queries ?? r.queries_total ?? 0}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {(r.lifetime_queries ?? r.queries_total ?? 0) > 0
                        ? `${(((r.lifetime_correct ?? 0) / (r.lifetime_queries ?? 1)) * 100).toFixed(0)}% accuracy (lifetime)`
                        : "no challenges yet"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase">Uptime</p>
                    <p className="text-lg font-semibold">
                      {r.uptime !== undefined ? `${(r.uptime * 100).toFixed(1)}%` : "-"}
                    </p>
                    <p className="text-[11px] text-slate-400 font-mono">
                      {r.health_checks_responded ?? 0}/{r.health_checks_total ?? 0} checks
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase">Attestations</p>
                    <p className="text-lg font-semibold font-mono">
                      {r.lifetime_attestations_valid ?? r.attestations_valid ?? 0}/{r.lifetime_attestations ?? r.attestations_total ?? 0}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {r.proactive_proof_verified ? "proactive proof verified" : "no proactive proof"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase">Notary Service</p>
                    <p className="text-lg font-semibold font-mono">
                      {r.notary_duties_completed ?? 0}/{r.notary_duties_assigned ?? 0}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {(r.notary_reliability ?? 0) > 0
                        ? `${((r.notary_reliability ?? 0) * 100).toFixed(0)}% reliability`
                        : "no duties yet"}
                    </p>
                  </div>
                </div>

                {r.weight_breakdown && (
                  <div className="text-xs mt-3 space-y-3">
                    <p className="text-slate-500 font-medium uppercase tracking-wide">Weight Breakdown</p>

                    {/* Final Scores */}
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Final Scores</p>
                      <div className="grid grid-cols-3 gap-2 bg-slate-50 rounded-lg p-3">
                        <div>
                          <span className="text-slate-400">Sports Score</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.sports_score !== undefined ? Number(r.weight_breakdown.sports_score).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Attestation Score</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.attestation_score !== undefined ? Number(r.weight_breakdown.attestation_score).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Raw Score</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.raw_score !== undefined ? Number(r.weight_breakdown.raw_score).toFixed(4) : "-"}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Components */}
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Components</p>
                      <div className="grid grid-cols-5 gap-2 bg-slate-50 rounded-lg p-3">
                        <div>
                          <span className="text-slate-400">Speed</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.speed !== undefined ? Number(r.weight_breakdown.speed).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Uptime</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.uptime !== undefined ? Number(r.weight_breakdown.uptime).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Accuracy</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.accuracy !== undefined ? Number(r.weight_breakdown.accuracy).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Coverage</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.coverage !== undefined ? Number(r.weight_breakdown.coverage).toFixed(4) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Capability</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.capability_score !== undefined ? Number(r.weight_breakdown.capability_score).toFixed(4) : "-"}
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* History & Notary */}
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">History & Notary</p>
                      <div className="grid grid-cols-3 gap-2 bg-slate-50 rounded-lg p-3">
                        <div>
                          <span className="text-slate-400">Consecutive Epochs</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.consecutive_epochs !== undefined ? String(r.weight_breakdown.consecutive_epochs) : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Notary Reliability</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.notary_reliability !== undefined
                              ? `${(Number(r.weight_breakdown.notary_reliability) * 100).toFixed(0)}%`
                              : "-"}
                          </p>
                        </div>
                        <div>
                          <span className="text-slate-400">Notary Capable</span>
                          <p className="font-mono text-sm font-semibold">
                            {r.weight_breakdown.notary_capable !== undefined
                              ? (r.weight_breakdown.notary_capable ? "Yes" : "No")
                              : "-"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-slate-300 border-t-slate-600 rounded-full mx-auto mb-4" />
          <p className="text-slate-500">Loading scores...</p>
        </div>
      )}
    </div>
  );
}
