"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchProtocolStats,
  fetchRecentSignals,
  fetchRecentPurchases,
  fetchRecentAudits,
  fetchRecentTrackRecordProofs,
  type SubgraphProtocolStats,
  type SubgraphRecentSignal,
  type SubgraphRecentPurchase,
  type SubgraphRecentAudit,
  type SubgraphRecentTrackRecord,
} from "@/lib/subgraph";
import { formatUsdc } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorReport {
  message: string;
  url: string;
  errorMessage: string;
  source: string;
  timestamp: string;
  wallet: string;
  signalId: string;
  ip: string;
}

interface ValidatorNode {
  uid: number;
  ip: string;
  port: number;
}

interface ValidatorHealth {
  uid: number;
  status: string;
  version: string;
  shares_held: number;
  chain_connected: boolean;
  bt_connected: boolean;
  error?: string;
}

interface MinerHealth {
  status: string;
  version: string;
  odds_api_connected: boolean;
  bt_connected: boolean;
  uptime_seconds: number;
  error?: string;
}

interface NetworkEvent {
  category: string;
  summary: string;
  timestamp: number;
  details: Record<string, unknown>;
  validatorUid?: number;
}

type AdminTab = "overview" | "network" | "protocol";

const GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL || "";
const BASE_EXPLORER = process.env.NEXT_PUBLIC_BASE_EXPLORER || "https://basescan.org";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const [validators, setValidators] = useState<ValidatorHealth[]>([]);
  const [miner, setMiner] = useState<MinerHealth | null>(null);
  const [stats, setStats] = useState<SubgraphProtocolStats | null>(null);
  const [errorReports, setErrorReports] = useState<ErrorReport[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  // Network tab data
  const [networkEvents, setNetworkEvents] = useState<NetworkEvent[]>([]);

  // Protocol tab data
  const [recentSignals, setRecentSignals] = useState<SubgraphRecentSignal[]>([]);
  const [recentPurchases, setRecentPurchases] = useState<SubgraphRecentPurchase[]>([]);
  const [recentAudits, setRecentAudits] = useState<SubgraphRecentAudit[]>([]);
  const [recentTrackRecords, setRecentTrackRecords] = useState<SubgraphRecentTrackRecord[]>([]);

  // Check for existing admin session cookie (set by server-side auth)
  useEffect(() => {
    const hasCookie = document.cookie.includes("djinn_admin_token=");
    if (hasCookie) setAuthed(true);
  }, []);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthed(true);
        setAuthError(false);
      } else {
        setAuthError(true);
      }
    } catch {
      setAuthError(true);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);

    // Always fetch core data
    const fetches: Promise<unknown>[] = [
      fetchValidatorHealth(),
      fetchMinerHealth(),
      fetchProtocolStats(),
      fetchErrorReports(),
    ];

    // Conditionally fetch tab data
    if (activeTab === "network") {
      fetches.push(fetchNetworkActivity());
    }
    if (activeTab === "protocol") {
      fetches.push(fetchRecentSignals(50));
      fetches.push(fetchRecentPurchases(50));
      fetches.push(fetchRecentAudits(50));
      fetches.push(fetchRecentTrackRecordProofs(50));
    }

    const results = await Promise.allSettled(fetches);

    // Core results (indices 0-3)
    if (results[0].status === "fulfilled") setValidators(results[0].value as ValidatorHealth[]);
    if (results[1].status === "fulfilled") setMiner(results[1].value as MinerHealth | null);
    if (results[2].status === "fulfilled") setStats(results[2].value as SubgraphProtocolStats | null);
    if (results[3].status === "fulfilled") {
      const errData = results[3].value as { errors: ErrorReport[]; total: number } | null;
      if (errData) {
        setErrorReports(errData.errors);
        setErrorTotal(errData.total);
      }
    }

    // Tab-specific results
    if (activeTab === "network" && results[4]?.status === "fulfilled") {
      setNetworkEvents(results[4].value as NetworkEvent[]);
    }
    if (activeTab === "protocol") {
      if (results[4]?.status === "fulfilled") setRecentSignals(results[4].value as SubgraphRecentSignal[]);
      if (results[5]?.status === "fulfilled") setRecentPurchases(results[5].value as SubgraphRecentPurchase[]);
      if (results[6]?.status === "fulfilled") setRecentAudits(results[6].value as SubgraphRecentAudit[]);
      if (results[7]?.status === "fulfilled") setRecentTrackRecords(results[7].value as SubgraphRecentTrackRecord[]);
    }

    setLastRefresh(new Date());
    setLoading(false);
  }, [activeTab]);

  useEffect(() => {
    if (!authed) return;
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [authed, refresh]);

  if (!authed) {
    return (
      <div className="max-w-md mx-auto py-20">
        <h1 className="text-2xl font-bold text-slate-900 mb-2 text-center">Admin Dashboard</h1>
        <p className="text-slate-500 text-sm text-center mb-8">Enter the admin password to continue.</p>
        <form onSubmit={handleAuth} className="card">
          <label htmlFor="admin-pass" className="label">Password</label>
          <input
            id="admin-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input mb-4"
            autoFocus
            required
          />
          {authError && (
            <p className="text-sm text-red-500 mb-3">Incorrect password.</p>
          )}
          <button type="submit" className="btn-primary w-full">Enter</button>
        </form>
      </div>
    );
  }

  const healthyValidators = validators.filter((v) => v.status === "ok");
  const totalShares = validators.reduce((sum, v) => sum + (v.shares_held || 0), 0);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-slate-500 mt-1">
            Djinn Protocol infrastructure monitoring
          </p>
        </div>
        <div className="flex items-center gap-4">
          {lastRefresh && (
            <span className="text-xs text-slate-400">
              Last: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          {GRAFANA_URL && (
            <a
              href={GRAFANA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 text-sm font-medium bg-genius-600 text-white rounded-lg hover:bg-genius-500"
            >
              Open Grafana
            </a>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex border-b border-slate-200 mb-8">
        {(
          [
            ["overview", "Overview"],
            ["network", "Network"],
            ["protocol", "Protocol"],
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {activeTab === "overview" && (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
            <StatCard
              label="Validators"
              value={`${healthyValidators.length}/${validators.length}`}
              status={healthyValidators.length >= 7 ? "green" : healthyValidators.length >= 4 ? "yellow" : "red"}
            />
            <StatCard
              label="Miner"
              value={miner?.status === "ok" ? "UP" : "DOWN"}
              status={miner?.status === "ok" ? "green" : "red"}
            />
            <StatCard
              label="Key Shares"
              value={totalShares.toString()}
              status="blue"
            />
            <StatCard
              label="Total Signals"
              value={stats?.totalSignals ?? "-"}
              status="blue"
            />
            <StatCard
              label="Purchases"
              value={stats?.totalPurchases ?? "-"}
              status="purple"
            />
            <StatCard
              label="Volume"
              value={stats?.totalVolume ? formatUsdc(BigInt(stats.totalVolume)) : "-"}
              status="purple"
            />
          </div>

          {/* Validator Grid */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Validators</h2>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">UID</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Version</th>
                    <th className="px-4 py-3 text-right font-medium">Shares</th>
                    <th className="px-4 py-3 text-center font-medium">Chain</th>
                    <th className="px-4 py-3 text-center font-medium">Bittensor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {validators.length === 0 && !loading && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                        No validators discovered
                      </td>
                    </tr>
                  )}
                  {validators.map((v) => (
                    <tr key={v.uid} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-slate-700">{v.uid}</td>
                      <td className="px-4 py-3">
                        {v.error ? (
                          <span className="inline-flex items-center gap-1 text-red-600">
                            <Dot color="red" /> Unreachable
                          </span>
                        ) : v.status === "ok" ? (
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <Dot color="green" /> Healthy
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-yellow-600">
                            <Dot color="yellow" /> {v.status}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {v.version || "-"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {v.error ? "-" : v.shares_held}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {v.error ? "-" : v.chain_connected ? (
                          <span className="text-green-500">connected</span>
                        ) : (
                          <span className="text-red-500">disconnected</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {v.error ? "-" : v.bt_connected ? (
                          <span className="text-green-500">connected</span>
                        ) : (
                          <span className="text-red-500">disconnected</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Miner Status */}
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-slate-900 mb-4">Miner</h2>
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              {miner?.error ? (
                <div className="text-red-600 flex items-center gap-2">
                  <Dot color="red" /> Miner unreachable: {miner.error}
                </div>
              ) : miner ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                  <div>
                    <span className="text-xs text-slate-400 block mb-1">Status</span>
                    <span className={`font-medium ${miner.status === "ok" ? "text-green-600" : "text-yellow-600"}`}>
                      {miner.status === "ok" ? "Healthy" : miner.status}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 block mb-1">Version</span>
                    <span className="font-mono text-sm text-slate-700">{miner.version || "-"}</span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 block mb-1">Odds API</span>
                    <span className={miner.odds_api_connected ? "text-green-600" : "text-red-600"}>
                      {miner.odds_api_connected ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-slate-400 block mb-1">Uptime</span>
                    <span className="font-mono text-sm text-slate-700">
                      {formatUptime(miner.uptime_seconds)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-slate-400">Loading...</div>
              )}
            </div>
          </div>

          {/* Protocol Stats */}
          {stats && (
            <div className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Protocol Statistics</h2>
              <div className="bg-white rounded-xl border border-slate-200 p-6 grid grid-cols-2 sm:grid-cols-4 gap-6">
                <div>
                  <span className="text-xs text-slate-400 block mb-1">Unique Geniuses</span>
                  <span className="text-2xl font-bold text-slate-900">{stats.uniqueGeniuses}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block mb-1">Unique Idiots</span>
                  <span className="text-2xl font-bold text-slate-900">{stats.uniqueIdiots}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block mb-1">Total Audits</span>
                  <span className="text-2xl font-bold text-slate-900">{stats.totalAudits}</span>
                </div>
                <div>
                  <span className="text-xs text-slate-400 block mb-1">Track Record Proofs</span>
                  <span className="text-2xl font-bold text-slate-900">{stats.totalTrackRecordProofs}</span>
                </div>
              </div>
            </div>
          )}

          {/* Error Reports */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-slate-900">
                Error Reports
                {errorTotal > 0 && (
                  <span className="ml-2 text-sm font-normal text-slate-400">({errorTotal} total)</span>
                )}
              </h2>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              {errorReports.length === 0 ? (
                <div className="px-4 py-8 text-center text-slate-400 text-sm">
                  No error reports yet
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {errorReports.slice(0, 20).map((err, i) => (
                    <div key={i} className="px-4 py-3 hover:bg-slate-50">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${
                              err.source === "error-boundary"
                                ? "bg-red-100 text-red-700"
                                : err.source === "api-error"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-600"
                            }`}>
                              {err.source}
                            </span>
                            {err.wallet && (
                              <span className="text-[10px] font-mono text-slate-400">{err.wallet}</span>
                            )}
                          </div>
                          <p className="text-sm text-slate-900 truncate">{err.message}</p>
                          {err.errorMessage && err.errorMessage !== err.message && (
                            <p className="text-xs text-red-600 font-mono truncate mt-0.5">{err.errorMessage}</p>
                          )}
                          {err.url && (
                            <p className="text-[11px] text-slate-400 mt-0.5">{err.url}</p>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-400 whitespace-nowrap">
                          {new Date(err.timestamp).toLocaleString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Quick Links */}
          {GRAFANA_URL && (
            <div>
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Monitoring</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <ExternalLink
                  href={`${GRAFANA_URL}/d/djinn-overview`}
                  title="Protocol Overview"
                  description="Request rates, purchases, MPC performance"
                />
                <ExternalLink
                  href={`${GRAFANA_URL}/d/djinn-validators`}
                  title="Validator Metrics"
                  description="Per-validator shares, latency, errors"
                />
                <ExternalLink
                  href={`${GRAFANA_URL}/d/djinn-miner`}
                  title="Miner Metrics"
                  description="Line checks, cache hit rate, Odds API"
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Network Tab (Miners & Validators Activity) ── */}
      {activeTab === "network" && (
        <NetworkActivityTab events={networkEvents} loading={loading} />
      )}

      {/* ── Protocol Tab (Geniuses & Idiots Activity) ── */}
      {activeTab === "protocol" && (
        <ProtocolActivityTab
          signals={recentSignals}
          purchases={recentPurchases}
          audits={recentAudits}
          trackRecords={recentTrackRecords}
          loading={loading}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network Activity Tab
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  challenge_round: "bg-blue-100 text-blue-700",
  health_check: "bg-green-100 text-green-700",
  outcome_resolution: "bg-purple-100 text-purple-700",
  weight_set: "bg-amber-100 text-amber-700",
  attestation_challenge: "bg-cyan-100 text-cyan-700",
  purchase: "bg-emerald-100 text-emerald-700",
  share_stored: "bg-slate-100 text-slate-600",
};

function NetworkActivityTab({ events, loading }: { events: NetworkEvent[]; loading: boolean }) {
  if (loading && events.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading network activity...</div>;
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-medium text-slate-700">
          Validator &amp; Miner Activity
          <span className="ml-2 text-xs text-slate-400">({events.length} events)</span>
        </h3>
      </div>
      {events.length === 0 ? (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">
          No activity recorded yet. Events appear after the validator runs an epoch.
        </div>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[700px] overflow-y-auto">
          {events.map((event, i) => (
            <div key={i} className="px-4 py-3 hover:bg-slate-50">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded whitespace-nowrap ${
                      CATEGORY_COLORS[event.category] || "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {event.category.replace(/_/g, " ")}
                  </span>
                  <span className="text-sm text-slate-700 truncate">{event.summary}</span>
                  {event.validatorUid !== undefined && (
                    <span className="text-[10px] text-slate-400 font-mono">v{event.validatorUid}</span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 whitespace-nowrap">
                  {formatEventTime(event.timestamp)}
                </span>
              </div>
              {Object.keys(event.details || {}).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(event.details).map(([k, v]) => (
                    <span key={k} className="text-[10px] text-slate-400 font-mono">
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Protocol Activity Tab
// ---------------------------------------------------------------------------

function ProtocolActivityTab({
  signals,
  purchases,
  audits,
  trackRecords,
  loading,
}: {
  signals: SubgraphRecentSignal[];
  purchases: SubgraphRecentPurchase[];
  audits: SubgraphRecentAudit[];
  trackRecords: SubgraphRecentTrackRecord[];
  loading: boolean;
}) {
  if (loading && signals.length === 0 && purchases.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading protocol activity...</div>;
  }

  return (
    <div className="space-y-8">
      {/* Recent Signals */}
      <ActivitySection title="Recent Signals" count={signals.length}>
        {signals.slice(0, 25).map((s) => (
          <ActivityRow
            key={s.id}
            badge={s.status}
            badgeColor={s.status === "Active" ? "bg-green-100 text-green-700" : s.status === "Cancelled" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}
            title={`Signal #${s.id}`}
            subtitle={`${s.sport} by ${truncAddr(s.genius.id)} | max ${Number(s.maxPriceBps) / 100}%`}
            timestamp={Number(s.createdAt)}
            txHash={s.createdAtTx}
          />
        ))}
      </ActivitySection>

      {/* Recent Purchases */}
      <ActivitySection title="Recent Purchases" count={purchases.length}>
        {purchases.slice(0, 25).map((p) => (
          <ActivityRow
            key={p.id}
            badge={p.outcome}
            badgeColor={outcomeColor(p.outcome)}
            title={`Purchase #${p.id} \u2014 ${formatUsdc(BigInt(p.notional))}`}
            subtitle={`${truncAddr(p.idiot.id)} bought signal #${p.signal.id} (${p.signal.sport})`}
            timestamp={Number(p.purchasedAt)}
            txHash={p.purchasedAtTx}
          />
        ))}
      </ActivitySection>

      {/* Recent Audits */}
      <ActivitySection title="Recent Audit Settlements" count={audits.length}>
        {audits.slice(0, 25).map((a) => (
          <ActivityRow
            key={a.id}
            badge={a.isEarlyExit ? "Early Exit" : `QS: ${a.qualityScore}`}
            badgeColor={
              a.isEarlyExit
                ? "bg-amber-100 text-amber-700"
                : Number(a.qualityScore) >= 0
                  ? "bg-green-100 text-green-700"
                  : "bg-red-100 text-red-700"
            }
            title={`Cycle ${a.cycle} \u2014 ${truncAddr(a.genius.id)} / ${truncAddr(a.idiot.id)}`}
            subtitle={`A: ${formatUsdc(BigInt(a.trancheA))} | B: ${formatUsdc(BigInt(a.trancheB))} | Fee: ${formatUsdc(BigInt(a.protocolFee))}`}
            timestamp={Number(a.settledAt)}
            txHash={a.settledAtTx}
          />
        ))}
      </ActivitySection>

      {/* Track Record Proofs */}
      <ActivitySection title="Track Record Proofs" count={trackRecords.length}>
        {trackRecords.slice(0, 25).map((tr) => (
          <ActivityRow
            key={tr.id}
            badge={`${tr.signalCount} signals`}
            badgeColor="bg-purple-100 text-purple-700"
            title={`Proof #${tr.id} by ${truncAddr(tr.genius.id)}`}
            subtitle={`W/L/V: ${tr.favCount}/${tr.unfavCount}/${tr.voidCount} | +${formatUsdc(BigInt(tr.totalGain))} / -${formatUsdc(BigInt(tr.totalLoss))}`}
            timestamp={Number(tr.submittedAt)}
            txHash={tr.submittedAtTx}
          />
        ))}
      </ActivitySection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function ActivitySection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-medium text-slate-700">
          {title}
          <span className="ml-2 text-xs text-slate-400">({count})</span>
        </h3>
      </div>
      {count === 0 ? (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">No data</div>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[400px] overflow-y-auto">{children}</div>
      )}
    </div>
  );
}

function ActivityRow({
  badge,
  badgeColor,
  title,
  subtitle,
  timestamp,
  txHash,
}: {
  badge: string;
  badgeColor: string;
  title: string;
  subtitle: string;
  timestamp: number;
  txHash?: string;
}) {
  const date = new Date(timestamp * 1000);
  return (
    <div className="px-4 py-3 hover:bg-slate-50">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${badgeColor}`}>
              {badge}
            </span>
            <span className="text-sm text-slate-900 truncate">{title}</span>
          </div>
          <p className="text-xs text-slate-500 truncate">{subtitle}</p>
        </div>
        <div className="text-right whitespace-nowrap">
          <span className="text-[10px] text-slate-400 block">{date.toLocaleDateString()}</span>
          <span className="text-[10px] text-slate-400 block">{date.toLocaleTimeString()}</span>
          {txHash && (
            <a
              href={`${BASE_EXPLORER}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-500 hover:text-blue-700 font-mono"
            >
              {txHash.slice(0, 10)}...
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, status }: { label: string; value: string; status: string }) {
  const colors: Record<string, string> = {
    green: "border-green-200 bg-green-50",
    yellow: "border-yellow-200 bg-yellow-50",
    red: "border-red-200 bg-red-50",
    blue: "border-blue-200 bg-blue-50",
    purple: "border-purple-200 bg-purple-50",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[status] || "border-slate-200 bg-white"}`}>
      <span className="text-xs text-slate-500 block mb-1">{label}</span>
      <span className="text-2xl font-bold text-slate-900">{value}</span>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  const cls: Record<string, string> = {
    green: "bg-green-500",
    yellow: "bg-yellow-500",
    red: "bg-red-500",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${cls[color] || "bg-slate-300"}`} />;
}

function ExternalLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-4 bg-white rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all"
    >
      <span className="font-medium text-slate-900 block">{title}</span>
      <span className="text-xs text-slate-500 mt-1 block">{description}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function truncAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "Favorable": return "bg-green-100 text-green-700";
    case "Unfavorable": return "bg-red-100 text-red-700";
    case "Void": return "bg-amber-100 text-amber-700";
    default: return "bg-slate-100 text-slate-600";
  }
}

function formatEventTime(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString();
  }
  return date.toLocaleString();
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchValidatorHealth(): Promise<ValidatorHealth[]> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return [];
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };

    const results = await Promise.allSettled(
      validators.map(async (v) => {
        const res = await fetch(`/api/validators/${v.uid}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        return { ...data, uid: v.uid } as ValidatorHealth;
      }),
    );

    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { uid: validators[i].uid, status: "error", version: "", shares_held: 0, chain_connected: false, bt_connected: false, error: String((r as PromiseRejectedResult).reason) },
    );
  } catch {
    return [];
  }
}

async function fetchNetworkActivity(): Promise<NetworkEvent[]> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return [];
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };

    const results = await Promise.allSettled(
      validators.map(async (v) => {
        const res = await fetch(`/api/validators/${v.uid}/v1/activity?limit=100`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        return ((data.events || []) as NetworkEvent[]).map((e) => ({
          ...e,
          validatorUid: v.uid,
        }));
      }),
    );

    const all: NetworkEvent[] = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<NetworkEvent[]>).value);
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, 200);
  } catch {
    return [];
  }
}

async function fetchErrorReports(): Promise<{ errors: ErrorReport[]; total: number } | null> {
  try {
    const res = await fetch("/api/admin/errors?limit=50", {
      signal: AbortSignal.timeout(5000),
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchMinerHealth(): Promise<MinerHealth | null> {
  try {
    const res = await fetch("/api/miner/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { status: "error", version: "", odds_api_connected: false, bt_connected: false, uptime_seconds: 0, error: `${res.status}` };
    return await res.json();
  } catch (err) {
    return { status: "error", version: "", odds_api_connected: false, bt_connected: false, uptime_seconds: 0, error: String(err) };
  }
}
