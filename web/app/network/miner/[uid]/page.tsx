"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import StatCard from "@/components/network/StatCard";
import MetricDropdown from "@/components/network/MetricDropdown";
import ViewToggle from "@/components/network/ViewToggle";
import ScoreTree from "@/components/network/ScoreTree";

// Lazy-load chart (needs canvas)
const TimeseriesChart = dynamic(
  () => import("@/components/network/TimeseriesChart"),
  { ssr: false, loading: () => <div className="h-64 bg-slate-50 rounded-lg animate-pulse" /> },
);

// ---------- Types ----------

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

interface Metagraph {
  ip: string;
  incentive: number;
  emission: string;
  isValidator: boolean;
  stake: string;
}

interface HistoryPoint {
  t: number;
  weight: number;
  accuracy?: number;
  speed?: number;
  uptime?: number;
  sports_score?: number;
  attestation_score?: number;
}

// ---------- Main Page ----------

const HISTORY_METRICS = [
  { value: "weight", label: "Weight" },
  { value: "sports_score", label: "Sports Score" },
  { value: "attestation_score", label: "Attestation Score" },
  { value: "accuracy", label: "Accuracy" },
  { value: "uptime", label: "Uptime" },
];

export default function MinerPage() {
  const params = useParams();
  const uid = params.uid as string;
  const [results, setResults] = useState<MinerScores[]>([]);
  const [metagraph, setMetagraph] = useState<Metagraph | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");
  const [error, setError] = useState("");
  const [historyMetric, setHistoryMetric] = useState("weight");
  const [view, setView] = useState<"chart" | "table">("chart");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [scoreRes, histRes] = await Promise.allSettled([
        fetch(`/api/network/miner/${uid}`).then((r) => r.json()),
        fetch(`/api/network/miner/${uid}/history`).then((r) => r.json()),
      ]);

      if (scoreRes.status === "fulfilled") {
        const data = scoreRes.value;
        if (data.scores?.length > 0) {
          setResults(data.scores);
          setError("");
        } else {
          setError("No validators returned data for this UID.");
        }
        if (data.metagraph) setMetagraph(data.metagraph);
      }

      if (histRes.status === "fulfilled" && histRes.value.history?.length > 0) {
        setHistory(histRes.value.history);
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

  // Aggregations
  const totalWeight = results.reduce((s, r) => s + (r.weight ?? 0), 0);
  const avgUptime = results.length
    ? results.reduce((s, r) => s + (r.uptime ?? 0), 0) / results.length
    : 0;
  const bestResult = results.reduce(
    (best, r) => ((r.lifetime_queries ?? 0) > (best.lifetime_queries ?? 0) ? r : best),
    results[0] || {},
  );
  const accuracy =
    (bestResult.lifetime_queries ?? 0) > 0
      ? (bestResult.lifetime_correct ?? 0) / (bestResult.lifetime_queries ?? 1)
      : 0;
  const attestRate =
    (bestResult.lifetime_attestations ?? 0) > 0
      ? (bestResult.lifetime_attestations_valid ?? 0) / (bestResult.lifetime_attestations ?? 1)
      : 0;

  // Deltas from history (compare latest to 24h ago)
  function getDelta(field: string): number | null {
    if (history.length < 2) return null;
    const latest = history[history.length - 1];
    const cutoff = latest.t - 86400;
    const past = history.find((h) => h.t >= cutoff) ?? history[0];
    const nowVal = (latest as unknown as Record<string, number>)[field] ?? 0;
    const pastVal = (past as unknown as Record<string, number>)[field] ?? 0;
    if (pastVal === 0) return null;
    return ((nowVal - pastVal) / pastVal) * 100;
  }

  const u16Pct = (v: number) => ((v / 65535) * 100).toFixed(2) + "%";

  return (
    <div className="max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6">
        <Link href="/network" className="text-slate-400 hover:text-slate-600 text-sm">
          Network
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-sm text-slate-600">Miner {uid}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Image src="/djinn-logo.png" alt="Djinn" width={32} height={32} />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Miner UID {uid}</h1>
            <p className="text-sm text-slate-400">
              {metagraph && `IP: ${metagraph.ip} | Incentive: ${u16Pct(metagraph.incentive)} | `}
              {results.length} validator{results.length !== 1 ? "s" : ""} reporting
              {lastUpdate && ` | Updated ${lastUpdate}`}
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
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <StatCard
              label="Total Weight"
              value={totalWeight.toFixed(4)}
              sub={`across ${results.length} validators`}
              delta={getDelta("weight")}
            />
            <StatCard
              label="Accuracy"
              value={`${(accuracy * 100).toFixed(1)}%`}
              sub={`${bestResult.lifetime_correct ?? 0}/${bestResult.lifetime_queries ?? 0}`}
              delta={getDelta("accuracy")}
            />
            <StatCard
              label="Uptime"
              value={`${(avgUptime * 100).toFixed(1)}%`}
              sub="avg across validators"
              delta={getDelta("uptime")}
            />
            <StatCard
              label="Attestations"
              value={`${(attestRate * 100).toFixed(1)}%`}
              sub={`${bestResult.lifetime_attestations_valid ?? 0}/${bestResult.lifetime_attestations ?? 0}`}
            />
          </div>

          {/* Timeseries */}
          {history.length > 0 && (
            <section className="card mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Score History</h2>
                  <p className="text-sm text-slate-500">{history.length} data points</p>
                </div>
                <div className="flex items-center gap-3">
                  <MetricDropdown
                    options={HISTORY_METRICS}
                    selected={historyMetric}
                    onChange={setHistoryMetric}
                  />
                  <ViewToggle view={view} onChange={setView} />
                </div>
              </div>

              {view === "chart" ? (
                <TimeseriesChart history={history} metric={historyMetric} />
              ) : (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
                        <th className="px-3 py-2">Timestamp</th>
                        <th className="px-3 py-2 text-right">Weight</th>
                        <th className="px-3 py-2 text-right">Sports</th>
                        <th className="px-3 py-2 text-right">Attestation</th>
                        <th className="px-3 py-2 text-right">Accuracy</th>
                        <th className="px-3 py-2 text-right">Uptime</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...history].reverse().map((h, i) => (
                        <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-500">
                            {new Date(h.t * 1000).toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">{h.weight.toFixed(4)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{h.sports_score?.toFixed(4) ?? "-"}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{h.attestation_score?.toFixed(4) ?? "-"}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{h.accuracy?.toFixed(4) ?? "-"}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{h.uptime?.toFixed(4) ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* Per-validator scoring */}
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Per-Validator Scoring</h2>
          <div className="space-y-4 mb-8">
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

                {/* Quick metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                  <div>
                    <p className="text-[11px] text-slate-400 uppercase">Line Challenges</p>
                    <p className="text-lg font-semibold font-mono">
                      {r.lifetime_correct ?? r.queries_correct ?? 0}/{r.lifetime_queries ?? r.queries_total ?? 0}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {(r.lifetime_queries ?? r.queries_total ?? 0) > 0
                        ? `${(((r.lifetime_correct ?? 0) / (r.lifetime_queries ?? 1)) * 100).toFixed(0)}% accuracy`
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

                {/* Score breakdown tree */}
                {r.weight_breakdown && (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">
                      Weight Breakdown
                    </p>
                    <ScoreTree breakdown={r.weight_breakdown} weight={r.weight} />
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
