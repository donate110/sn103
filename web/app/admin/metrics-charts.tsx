"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from "chart.js";
import { Line, Bar } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AttestBucket {
  t: number;
  total: number;
  success: number;
  verified: number;
  avg_latency: number | null;
  peer_notary: number;
  errors: number;
}

interface ChallengeBucket {
  t: number;
  rounds: number;
  challenged: number;
  responded: number;
  correct: number;
}

interface WeightBucket {
  t: number;
  attempts: number;
  success: number;
  failed: number;
}

interface TimeseriesData {
  attestations: AttestBucket[];
  challenges: ChallengeBucket[];
  weights: WeightBucket[];
  bucket_seconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffH = (now.getTime() - d.getTime()) / 3600000;
  if (diffH < 24) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function pct(num: number, denom: number): number {
  return denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0;
}

const CHART_COLORS = {
  green: "rgb(34, 197, 94)",
  greenBg: "rgba(34, 197, 94, 0.1)",
  blue: "rgb(59, 130, 246)",
  blueBg: "rgba(59, 130, 246, 0.1)",
  amber: "rgb(245, 158, 11)",
  amberBg: "rgba(245, 158, 11, 0.1)",
  red: "rgb(239, 68, 68)",
  redBg: "rgba(239, 68, 68, 0.1)",
  slate: "rgb(100, 116, 139)",
  slateBg: "rgba(100, 116, 139, 0.1)",
  purple: "rgb(168, 85, 247)",
  purpleBg: "rgba(168, 85, 247, 0.1)",
};

const baseLineOpts: ChartOptions<"line"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { position: "top", labels: { usePointStyle: true, boxWidth: 6, font: { size: 11 } } },
  },
  scales: {
    x: { ticks: { maxRotation: 0, maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false } },
    y: { beginAtZero: true, ticks: { font: { size: 10 } }, grid: { color: "rgba(0,0,0,0.04)" } },
  },
};

const baseBarOpts: ChartOptions<"bar"> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { position: "top", labels: { usePointStyle: true, boxWidth: 6, font: { size: 11 } } },
  },
  scales: {
    x: { ticks: { maxRotation: 0, maxTicksLimit: 12, font: { size: 10 } }, grid: { display: false }, stacked: true },
    y: { beginAtZero: true, ticks: { font: { size: 10 } }, grid: { color: "rgba(0,0,0,0.04)" }, stacked: true },
  },
};

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatPill({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-4 py-3">
      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold text-slate-900 mt-0.5">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MetricsCharts({ validators }: { validators: { uid: number }[] }) {
  const [data, setData] = useState<TimeseriesData | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<24 | 72 | 168>(72); // hours

  const refresh = useCallback(async () => {
    if (validators.length === 0) return;
    setLoading(true);
    try {
      // Fetch from all validators in parallel, merge results
      const allData = await Promise.allSettled(
        validators.map(async (v) => {
          const res = await fetch(
            `/api/validators/${v.uid}/v1/admin/metrics/timeseries?hours=${range}&bucket=3600`,
            { signal: AbortSignal.timeout(10000) },
          );
          if (!res.ok) return null;
          return (await res.json()) as TimeseriesData;
        }),
      );

      // Merge: use the response with the most attestation data
      let best: TimeseriesData | null = null;
      for (const r of allData) {
        if (r.status === "fulfilled" && r.value) {
          if (!best || r.value.attestations.length > best.attestations.length) {
            best = r.value;
          }
        }
      }
      setData(best);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [validators, range]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!data && !loading) return null;

  const attest = data?.attestations ?? [];
  const challenges = data?.challenges ?? [];
  const weights = data?.weights ?? [];

  // Compute aggregate stats
  const totalAttest = attest.reduce((s, b) => s + b.total, 0);
  const totalSuccess = attest.reduce((s, b) => s + b.success, 0);
  const totalVerified = attest.reduce((s, b) => s + b.verified, 0);
  const totalPeer = attest.reduce((s, b) => s + b.peer_notary, 0);
  const avgLatency =
    attest.filter((b) => b.avg_latency).reduce((s, b) => s + (b.avg_latency ?? 0), 0) /
    (attest.filter((b) => b.avg_latency).length || 1);
  const totalChallenged = challenges.reduce((s, b) => s + b.challenged, 0);
  const totalResponded = challenges.reduce((s, b) => s + b.responded, 0);
  const totalCorrect = challenges.reduce((s, b) => s + b.correct, 0);
  const weightAttempts = weights.reduce((s, b) => s + b.attempts, 0);
  const weightSuccesses = weights.reduce((s, b) => s + b.success, 0);

  // Labels (time)
  const attestLabels = attest.map((b) => fmtTime(b.t));
  const challengeLabels = challenges.map((b) => fmtTime(b.t));
  const weightLabels = weights.map((b) => fmtTime(b.t));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Network Metrics</h2>
        <div className="flex items-center gap-2">
          {([24, 72, 168] as const).map((h) => (
            <button
              key={h}
              onClick={() => setRange(h)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                range === h
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {h === 24 ? "24h" : h === 72 ? "3d" : "7d"}
            </button>
          ))}
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-1 text-xs font-medium rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-50"
          >
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatPill label="Attestations" value={String(totalAttest)} />
        <StatPill label="Success %" value={`${pct(totalSuccess, totalAttest)}%`} sub={`${totalSuccess}/${totalAttest}`} />
        <StatPill label="Verified %" value={`${pct(totalVerified, totalAttest)}%`} sub={`${totalVerified}/${totalAttest}`} />
        <StatPill label="Peer Notary %" value={`${pct(totalPeer, totalAttest)}%`} sub={`${totalPeer}/${totalAttest}`} />
        <StatPill label="Avg Latency" value={`${avgLatency.toFixed(1)}s`} />
        <StatPill label="Challenge Response %" value={`${pct(totalResponded, totalChallenged)}%`} sub={`${totalResponded}/${totalChallenged}`} />
        <StatPill label="Challenge Accuracy %" value={`${pct(totalCorrect, totalResponded)}%`} sub={`${totalCorrect}/${totalResponded}`} />
        <StatPill label="Weight Set %" value={`${pct(weightSuccesses, weightAttempts)}%`} sub={`${weightSuccesses}/${weightAttempts}`} />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Attestation Success & Verification Rate */}
        {attest.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Attestation Success Rate</h3>
            <div className="h-56">
              <Line
                options={{
                  ...baseLineOpts,
                  scales: {
                    ...baseLineOpts.scales,
                    y: { ...baseLineOpts.scales!.y, max: 100, ticks: { ...((baseLineOpts.scales!.y as Record<string, unknown>).ticks as Record<string, unknown>), callback: (v) => `${v}%` } },
                  },
                }}
                data={{
                  labels: attestLabels,
                  datasets: [
                    {
                      label: "Success %",
                      data: attest.map((b) => pct(b.success, b.total)),
                      borderColor: CHART_COLORS.green,
                      backgroundColor: CHART_COLORS.greenBg,
                      fill: true,
                      tension: 0.3,
                      pointRadius: 2,
                    },
                    {
                      label: "Verified %",
                      data: attest.map((b) => pct(b.verified, b.total)),
                      borderColor: CHART_COLORS.blue,
                      backgroundColor: CHART_COLORS.blueBg,
                      fill: true,
                      tension: 0.3,
                      pointRadius: 2,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}

        {/* Attestation Latency */}
        {attest.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Avg Attestation Latency</h3>
            <div className="h-56">
              <Line
                options={{
                  ...baseLineOpts,
                  scales: {
                    ...baseLineOpts.scales,
                    y: { ...baseLineOpts.scales!.y, ticks: { ...((baseLineOpts.scales!.y as Record<string, unknown>).ticks as Record<string, unknown>), callback: (v) => `${v}s` } },
                  },
                }}
                data={{
                  labels: attestLabels,
                  datasets: [
                    {
                      label: "Avg Latency (s)",
                      data: attest.map((b) => b.avg_latency ?? null),
                      borderColor: CHART_COLORS.amber,
                      backgroundColor: CHART_COLORS.amberBg,
                      fill: true,
                      tension: 0.3,
                      pointRadius: 2,
                      spanGaps: true,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}

        {/* Attestation Volume: Peer vs PSE */}
        {attest.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Attestation Volume</h3>
            <div className="h-56">
              <Bar
                options={baseBarOpts}
                data={{
                  labels: attestLabels,
                  datasets: [
                    {
                      label: "Peer Notary",
                      data: attest.map((b) => b.peer_notary),
                      backgroundColor: CHART_COLORS.blue,
                    },
                    {
                      label: "PSE / No Notary",
                      data: attest.map((b) => b.total - b.peer_notary),
                      backgroundColor: CHART_COLORS.slate,
                    },
                    {
                      label: "Errors",
                      data: attest.map((b) => b.errors),
                      backgroundColor: CHART_COLORS.red,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}

        {/* Challenge Response Rate */}
        {challenges.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Challenge Response & Accuracy</h3>
            <div className="h-56">
              <Line
                options={{
                  ...baseLineOpts,
                  scales: {
                    ...baseLineOpts.scales,
                    y: { ...baseLineOpts.scales!.y, max: 100, ticks: { ...((baseLineOpts.scales!.y as Record<string, unknown>).ticks as Record<string, unknown>), callback: (v) => `${v}%` } },
                  },
                }}
                data={{
                  labels: challengeLabels,
                  datasets: [
                    {
                      label: "Response %",
                      data: challenges.map((b) => pct(b.responded, b.challenged)),
                      borderColor: CHART_COLORS.green,
                      backgroundColor: CHART_COLORS.greenBg,
                      fill: true,
                      tension: 0.3,
                      pointRadius: 2,
                    },
                    {
                      label: "Accuracy %",
                      data: challenges.map((b) => pct(b.correct, b.responded)),
                      borderColor: CHART_COLORS.purple,
                      backgroundColor: CHART_COLORS.purpleBg,
                      fill: true,
                      tension: 0.3,
                      pointRadius: 2,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}

        {/* Weight Setting */}
        {weights.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Weight Setting</h3>
            <div className="h-56">
              <Bar
                options={{
                  ...baseBarOpts,
                  scales: {
                    ...baseBarOpts.scales,
                    y: { ...baseBarOpts.scales!.y, stacked: true },
                  },
                }}
                data={{
                  labels: weightLabels,
                  datasets: [
                    {
                      label: "Success",
                      data: weights.map((b) => b.success),
                      backgroundColor: CHART_COLORS.green,
                    },
                    {
                      label: "Failed",
                      data: weights.map((b) => b.failed),
                      backgroundColor: CHART_COLORS.red,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}

        {/* Challenge Volume */}
        {challenges.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Challenge Volume</h3>
            <div className="h-56">
              <Bar
                options={baseBarOpts}
                data={{
                  labels: challengeLabels,
                  datasets: [
                    {
                      label: "Challenged",
                      data: challenges.map((b) => b.challenged),
                      backgroundColor: CHART_COLORS.blue,
                    },
                    {
                      label: "Responded",
                      data: challenges.map((b) => b.responded),
                      backgroundColor: CHART_COLORS.green,
                    },
                    {
                      label: "Correct",
                      data: challenges.map((b) => b.correct),
                      backgroundColor: CHART_COLORS.purple,
                    },
                  ],
                }}
              />
            </div>
          </div>
        )}
      </div>

      {data && attest.length === 0 && challenges.length === 0 && weights.length === 0 && (
        <div className="text-center text-slate-400 py-8 text-sm">
          No metrics data available for this time range.
        </div>
      )}
    </div>
  );
}
