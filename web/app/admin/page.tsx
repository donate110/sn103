"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchProtocolStats,
  fetchRecentSignals,
  fetchRecentPurchases,
  fetchRecentAudits,
  type SubgraphProtocolStats,
  type SubgraphRecentSignal,
  type SubgraphRecentPurchase,
  type SubgraphRecentAudit,
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

interface AttestationEntry {
  id: number;
  tx_hash: string;
  coldkey: string;
  url: string;
  request_id: string;
  success: boolean;
  verified: boolean;
  server_name: string | null;
  miner_uid: number | null;
  elapsed_s: number | null;
  error: string | null;
  created_at: number;
}

interface BurnHourStat {
  hour: number;
  count: number;
  amount: number;
}

type AdminTab = "overview" | "network" | "protocol" | "attestations";

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
  const [networkDiag, setNetworkDiag] = useState<{ discovered: number; responded: number; error?: string } | null>(null);

  // Protocol tab data
  const [recentSignals, setRecentSignals] = useState<SubgraphRecentSignal[]>([]);
  const [recentPurchases, setRecentPurchases] = useState<SubgraphRecentPurchase[]>([]);
  const [recentAudits, setRecentAudits] = useState<SubgraphRecentAudit[]>([]);

  // Attestations tab data
  const [attestations, setAttestations] = useState<AttestationEntry[]>([]);
  const [burnStats, setBurnStats] = useState<BurnHourStat[]>([]);
  const [hideZeroBurns, setHideZeroBurns] = useState(true);

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
    }
    if (activeTab === "attestations") {
      fetches.push(fetchAttestationData());
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
      const actResult = results[4].value as NetworkActivityResult;
      setNetworkEvents(actResult.events);
      setNetworkDiag({ discovered: actResult.validatorsDiscovered, responded: actResult.validatorsResponded, error: actResult.error });
    }
    if (activeTab === "protocol") {
      if (results[4]?.status === "fulfilled") setRecentSignals(results[4].value as SubgraphRecentSignal[]);
      if (results[5]?.status === "fulfilled") setRecentPurchases(results[5].value as SubgraphRecentPurchase[]);
      if (results[6]?.status === "fulfilled") setRecentAudits(results[6].value as SubgraphRecentAudit[]);
    }
    if (activeTab === "attestations" && results[4]?.status === "fulfilled") {
      const ad = results[4].value as { attestations: AttestationEntry[]; burnStats: BurnHourStat[] };
      setAttestations(ad.attestations);
      setBurnStats(ad.burnStats);
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
            ["attestations", "Attestations"],
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
              <div className="bg-white rounded-xl border border-slate-200 p-6 grid grid-cols-3 gap-6">
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
        <NetworkActivityTab events={networkEvents} loading={loading} diag={networkDiag} />
      )}

      {/* ── Protocol Tab (Geniuses & Idiots Activity) ── */}
      {activeTab === "protocol" && (
        <ProtocolActivityTab
          signals={recentSignals}
          purchases={recentPurchases}
          audits={recentAudits}
          loading={loading}
        />
      )}

      {activeTab === "attestations" && (
        <AttestationsTab
          attestations={attestations}
          burnStats={burnStats}
          hideZeros={hideZeroBurns}
          onToggleZeros={() => setHideZeroBurns((h) => !h)}
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

const CATEGORY_LABELS: Record<string, string> = {
  challenge_round: "Challenges",
  health_check: "Health",
  outcome_resolution: "Outcomes",
  weight_set: "Weights",
  attestation_challenge: "Attestation",
  purchase: "Purchases",
  share_stored: "Shares",
};

function NetworkActivityTab({ events, loading, diag }: { events: NetworkEvent[]; loading: boolean; diag: { discovered: number; responded: number; error?: string } | null }) {
  const [filter, setFilter] = useState<string | null>(null);

  if (loading && events.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading network activity...</div>;
  }

  const filtered = filter ? events.filter((e) => e.category === filter) : events;
  const categories = [...new Set(events.map((e) => e.category))];

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-medium text-slate-700">
          Validator &amp; Miner Activity
          <span className="ml-2 text-xs text-slate-400">({filtered.length}{filter ? ` of ${events.length}` : ""} events)</span>
        </h3>
        {diag && (
          <p className="text-[11px] text-slate-400 mt-1">
            {diag.discovered} validator{diag.discovered !== 1 ? "s" : ""} discovered, {diag.responded} responded
            {diag.error && <span className="text-red-400 ml-2">{diag.error}</span>}
          </p>
        )}
        {categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            <button
              onClick={() => setFilter(null)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                !filter ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500 hover:bg-slate-300"
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilter(filter === cat ? null : cat)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  filter === cat
                    ? "bg-slate-900 text-white"
                    : CATEGORY_COLORS[cat] || "bg-slate-100 text-slate-600"
                }`}
              >
                {CATEGORY_LABELS[cat] || cat.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">
          {events.length === 0
            ? diag?.discovered === 0
              ? "No validators discovered in the metagraph. Validators must register their axon to be visible."
              : diag?.responded === 0
                ? "Validators discovered but none responded. They may be behind a firewall or still starting up."
                : "No activity recorded yet. Validators record events every ~12 seconds once the epoch loop starts."
            : "No events match this filter."
          }
        </div>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[700px] overflow-y-auto">
          {filtered.map((event, i) => (
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
  loading,
}: {
  signals: SubgraphRecentSignal[];
  purchases: SubgraphRecentPurchase[];
  audits: SubgraphRecentAudit[];
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

    </div>
  );
}

// ---------------------------------------------------------------------------
// Attestations Tab
// ---------------------------------------------------------------------------

const POLKADOT_EXPLORER = "https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fentrypoint-finney.opentensor.ai%3A443#/explorer/query";

function AttestationsTab({
  attestations,
  burnStats,
  hideZeros,
  onToggleZeros,
  loading,
}: {
  attestations: AttestationEntry[];
  burnStats: BurnHourStat[];
  hideZeros: boolean;
  onToggleZeros: () => void;
  loading: boolean;
}) {
  if (loading && attestations.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading attestation data...</div>;
  }

  const totalTao7d = burnStats.reduce((s, b) => s + b.amount, 0);
  const totalCount7d = burnStats.reduce((s, b) => s + b.count, 0);
  const filteredStats = hideZeros ? burnStats.filter((b) => b.count > 0) : burnStats;

  return (
    <div className="space-y-8">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4">
          <div className="text-xs text-cyan-600 font-medium">Total Attestations (7d)</div>
          <div className="text-2xl font-bold text-cyan-900 mt-1">{totalCount7d}</div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-xs text-emerald-600 font-medium">TAO Collected (7d)</div>
          <div className="text-2xl font-bold text-emerald-900 mt-1">{totalTao7d.toFixed(6)}</div>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="text-xs text-blue-600 font-medium">Avg / Day</div>
          <div className="text-2xl font-bold text-blue-900 mt-1">{(totalCount7d / 7).toFixed(1)}</div>
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <div className="text-xs text-purple-600 font-medium">Success Rate</div>
          <div className="text-2xl font-bold text-purple-900 mt-1">
            {attestations.length > 0
              ? `${((attestations.filter((a) => a.success).length / attestations.length) * 100).toFixed(0)}%`
              : "—"}
          </div>
        </div>
      </div>

      {/* Recent Attestations Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-medium text-slate-700">
            Recent Attestations
            <span className="ml-2 text-xs text-slate-400">({attestations.length})</span>
          </h3>
        </div>
        {attestations.length === 0 ? (
          <div className="px-4 py-8 text-center text-slate-400 text-sm">No attestations yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-left">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Sender</th>
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-3 py-2 font-medium">Burn TX</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Verified</th>
                  <th className="px-3 py-2 font-medium">Miner</th>
                  <th className="px-3 py-2 font-medium">Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attestations.map((a) => {
                  const date = new Date(a.created_at * 1000);
                  return (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                        {date.toLocaleDateString()} {date.toLocaleTimeString()}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-700" title={a.coldkey}>
                        {a.coldkey.slice(0, 8)}...
                      </td>
                      <td className="px-3 py-2 max-w-[200px] truncate">
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800" title={a.url}>
                          {a.url.replace(/^https?:\/\//, "").slice(0, 40)}
                        </a>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <a
                          href={`${POLKADOT_EXPLORER}/${a.tx_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:text-blue-700"
                          title={a.tx_hash}
                        >
                          {a.tx_hash.slice(0, 10)}...
                        </a>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          a.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                        }`}>
                          {a.success ? "Success" : "Failed"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {a.success ? (
                          a.verified ? (
                            <span className="text-green-600" title="Proof verified">&#10003;</span>
                          ) : (
                            <span className="text-red-500" title={a.error || "Not verified"}>&#10007;</span>
                          )
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-600">
                        {a.miner_uid !== null ? `UID ${a.miner_uid}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {a.elapsed_s !== null ? `${a.elapsed_s}s` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Hourly Burn Stats */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">
            Burn Collection (Hourly)
            <span className="ml-2 text-xs text-slate-400">({filteredStats.length} hours)</span>
          </h3>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
            <input
              type="checkbox"
              checked={hideZeros}
              onChange={onToggleZeros}
              className="rounded border-slate-300 text-slate-600 focus:ring-slate-500"
            />
            Hide zero hours
          </label>
        </div>
        {filteredStats.length === 0 ? (
          <div className="px-4 py-8 text-center text-slate-400 text-sm">No burn data</div>
        ) : (
          <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-slate-500 text-left">
                  <th className="px-3 py-2 font-medium">Hour</th>
                  <th className="px-3 py-2 font-medium text-right">Attestations</th>
                  <th className="px-3 py-2 font-medium text-right">TAO Collected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredStats.map((s) => {
                  const date = new Date(s.hour * 1000);
                  return (
                    <tr key={s.hour} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-600">
                        {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-slate-900">{s.count}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">{s.amount.toFixed(6)} TAO</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
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

interface NetworkActivityResult {
  events: NetworkEvent[];
  validatorsDiscovered: number;
  validatorsResponded: number;
  error?: string;
}

async function fetchNetworkActivity(): Promise<NetworkActivityResult> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return { events: [], validatorsDiscovered: 0, validatorsResponded: 0, error: `Discovery failed (${discoverRes.status})` };
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };

    if (validators.length === 0) {
      return { events: [], validatorsDiscovered: 0, validatorsResponded: 0, error: "No validators found in metagraph" };
    }

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

    const responded = results.filter((r) => r.status === "fulfilled" && (r.value as NetworkEvent[]).length >= 0).length;
    const all: NetworkEvent[] = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<NetworkEvent[]>).value);
    all.sort((a, b) => b.timestamp - a.timestamp);
    return { events: all.slice(0, 200), validatorsDiscovered: validators.length, validatorsResponded: responded };
  } catch (err) {
    return { events: [], validatorsDiscovered: 0, validatorsResponded: 0, error: String(err) };
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

async function fetchAttestationData(): Promise<{ attestations: AttestationEntry[]; burnStats: BurnHourStat[] }> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return { attestations: [], burnStats: [] };
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };
    if (validators.length === 0) return { attestations: [], burnStats: [] };

    const v = validators[0];
    const [attRes, statsRes] = await Promise.allSettled([
      fetch(`/api/validators/${v.uid}/v1/admin/attestations?limit=50`, { signal: AbortSignal.timeout(5000) }),
      fetch(`/api/validators/${v.uid}/v1/admin/burn-stats?days=7`, { signal: AbortSignal.timeout(5000) }),
    ]);

    let attestations: AttestationEntry[] = [];
    let burnStats: BurnHourStat[] = [];

    if (attRes.status === "fulfilled" && attRes.value.ok) {
      const data = await attRes.value.json();
      attestations = data.attestations || [];
    }
    if (statsRes.status === "fulfilled" && statsRes.value.ok) {
      const data = await statsRes.value.json();
      burnStats = data.stats || [];
    }

    return { attestations, burnStats };
  } catch {
    return { attestations: [], burnStats: [] };
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
