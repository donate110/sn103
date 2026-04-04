"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import CopyTableButton, { useCopyTable } from "@/components/CopyTableButton";
import MetricsCharts from "./metrics-charts";

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
  hotkey?: string;
  coldkey?: string;
  ss58Hotkey?: string;
  stake?: string;
  alphaStake?: string;
  taoStake?: string;
  incentive?: number;
  emission?: string;
  consensus?: number;
  trust?: number;
  validatorTrust?: number;
  dividends?: number;
  rank?: number;
}

interface MinerNode {
  uid: number;
  ip: string;
  port: number;
  hotkey?: string;
  coldkey?: string;
  ss58Hotkey?: string;
  stake?: string;
  alphaStake?: string;
  taoStake?: string;
  incentive?: number;
  emission?: string;
  rank?: number;
}

interface ValidatorHealth {
  uid: number;
  ip: string;
  port: number;
  hotkey?: string;
  coldkey?: string;
  ss58Hotkey?: string;
  stake?: string;
  alphaStake?: string;
  taoStake?: string;
  validatorTrust?: number;
  incentive?: number;
  emission?: string;
  status: string;
  version: string;
  shares_held: number;
  chain_connected: boolean;
  bt_connected: boolean;
  attest_capable: boolean;
  error?: string;
}

interface MinerHealth {
  uid: number;
  ip: string;
  port: number;
  hotkey?: string;
  coldkey?: string;
  ss58Hotkey?: string;
  stake?: string;
  alphaStake?: string;
  taoStake?: string;
  incentive?: number;
  emission?: string;
  status: string;
  version: string;
  odds_api_connected: boolean;
  bt_connected: boolean;
  uptime_seconds: number;
  error?: string;
}

function truncateHotkey(hotkey?: string): string {
  if (!hotkey) return "-";
  const h = hotkey.startsWith("0x") ? hotkey.slice(2) : hotkey;
  if (h.length <= 12) return `0x${h}`;
  return `0x${h.slice(0, 6)}...${h.slice(-6)}`;
}

/** Look up delegate name by hotkey first, then coldkey. */
function lookupName(names: Record<string, string>, hotkey?: string, coldkey?: string): string | null {
  if (hotkey && names[hotkey]) return names[hotkey];
  if (coldkey && names[coldkey]) return names[coldkey];
  return null;
}

function formatStake(raw?: string): string {
  if (!raw) return "-";
  const rao = BigInt(raw);
  const val = Number(rao) / 1e9;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}Mα`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}Kα`;
  if (val >= 1) return `${val.toFixed(1)}α`;
  return `${val.toFixed(4)}α`;
}

function stakeTooltip(alphaRaw?: string, taoRaw?: string): string {
  const alpha = alphaRaw ? (Number(BigInt(alphaRaw)) / 1e9).toFixed(0) : "?";
  const tao = taoRaw ? (Number(BigInt(taoRaw)) / 1e9).toFixed(0) : "?";
  return `α ${alpha} + τ ${tao}`;
}

function formatVTrust(raw?: number): string {
  if (raw === undefined || raw === null) return "-";
  return `${((raw / 65535) * 100).toFixed(1)}%`;
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
  url: string;
  request_id: string;
  success: boolean;
  verified: boolean;
  server_name: string | null;
  miner_uid: number | null;
  notary_uid: number | null;
  elapsed_s: number | null;
  error: string | null;
  created_at: number;
}

interface FeedbackEntry {
  id: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  html_url: string;
  message?: string;
  source?: string;
  page?: string;
  wallet?: string;
  errorMessage?: string;
}

interface TelemetryEvent {
  id: number;
  timestamp: number;
  category: string;
  summary: string;
  details: Record<string, unknown>;
  sourceType: "validator" | "miner";
  sourceUid: number;
}

type AdminTab = "overview" | "network" | "protocol" | "attestations" | "telemetry" | "feedback" | "metagraph";

const GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL || "";
const BASE_EXPLORER = process.env.NEXT_PUBLIC_BASE_EXPLORER || "https://basescan.org";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AdminDashboard() {
  const [validators, setValidators] = useState<ValidatorHealth[]>([]);
  const [miners, setMiners] = useState<MinerHealth[]>([]);
  const [stats, setStats] = useState<SubgraphProtocolStats | null>(null);
  const [errorReports, setErrorReports] = useState<ErrorReport[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshStep, setRefreshStep] = useState("");
  const [refreshSteps, setRefreshSteps] = useState<Record<string, "pending" | "done" | "error">>({});
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  // Network tab data
  const [networkEvents, setNetworkEvents] = useState<NetworkEvent[]>([]);
  const [networkDiag, setNetworkDiag] = useState<{ discovered: number; responded: number; error?: string } | null>(null);
  const [validatorFetchStatus, setValidatorFetchStatus] = useState<Record<number, "pending" | "success" | "error">>({});

  // Protocol tab data
  const [recentSignals, setRecentSignals] = useState<SubgraphRecentSignal[]>([]);
  const [recentPurchases, setRecentPurchases] = useState<SubgraphRecentPurchase[]>([]);
  const [recentAudits, setRecentAudits] = useState<SubgraphRecentAudit[]>([]);

  // Attestations tab data
  const [attestations, setAttestations] = useState<AttestationEntry[]>([]);

  // Telemetry tab data
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);

  // Feedback tab data
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState<"all" | "open" | "closed">("all");

  // Delegate names: hex hotkey → display name
  const [delegateNames, setDelegateNames] = useState<Record<string, string>>({});

  // Latest repo version from GitHub
  const [repoVersion, setRepoVersion] = useState<{ version: number; sha: string } | null>(null);

  // Table filter state
  const [minerFilter, setMinerFilter] = useState<"all" | "djinn" | "healthy" | "odds" | "operational">("all");
  const [validatorFilter, setValidatorFilter] = useState<"all" | "djinn" | "healthy" | "chain" | "shares">("all");

  // Copy table hooks
  const { ref: valTableRef, copy: copyValTable, copied: valCopied } = useCopyTable();
  const { ref: minerTableRef, copy: copyMinerTable, copied: minerCopied } = useCopyTable();

  // Check for existing admin session via server-side cookie verification
  useEffect(() => {
    fetch("/api/admin/auth", { credentials: "same-origin" })
      .then((res) => { if (res.ok) setAuthed(true); })
      .catch(() => {});
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

  // Track whether this is the first load (full fetch) or incremental
  const isFirstLoad = useRef(true);
  const lastFetchTs = useRef(0);

  const refresh = useCallback(async () => {
    const incremental = !isFirstLoad.current;
    setLoading(true);
    setRefreshStep("metagraph");

    // Helper to track completion of each fetch with per-step status
    let done = 0;
    const total = 12;
    const labels = [
      "validators", "miners", "subgraph", "errors",
      "network", "signals", "purchases", "audits",
      "attestations", "telemetry", "feedback", "delegates",
    ];
    const stepStatus: Record<string, "pending" | "done" | "error"> = {};
    for (const l of labels) stepStatus[l] = "pending";
    setRefreshSteps({ ...stepStatus });

    function trackStep(idx: number, status: "done" | "error") {
      stepStatus[labels[idx]] = status;
      done++;
      setRefreshSteps({ ...stepStatus });
      setRefreshStep(done < total ? labels.find((_, i) => stepStatus[labels[i]] === "pending") || `${done}/${total}` : "done");
    }

    // Incremental: pass the last fetch timestamp so we only get new data
    const sinceTs = incremental ? lastFetchTs.current : undefined;
    const now = Math.floor(Date.now() / 1000);

    // Fire all fetches in parallel, updating UI state as each one completes
    // instead of waiting for all 12 before showing anything
    await Promise.allSettled([
      fetchValidatorHealth().then(
        (val) => { trackStep(0, "done"); setValidators(val as ValidatorHealth[]); },
        () => { trackStep(0, "error"); },
      ),
      fetchMinerHealth().then(
        (val) => { trackStep(1, "done"); setMiners(val as MinerHealth[]); },
        () => { trackStep(1, "error"); },
      ),
      fetchProtocolStats().then(
        (val) => { trackStep(2, "done"); setStats(val as SubgraphProtocolStats | null); },
        () => { trackStep(2, "error"); },
      ),
      fetchErrorReports().then(
        (val) => {
          trackStep(3, "done");
          const errData = val as { errors: ErrorReport[]; total: number } | null;
          if (errData) { setErrorReports(errData.errors); setErrorTotal(errData.total); }
        },
        () => { trackStep(3, "error"); },
      ),
      fetchNetworkActivity((status) => setValidatorFetchStatus(status), sinceTs).then(
        (val) => {
          trackStep(4, "done");
          const actResult = val as NetworkActivityResult;
          if (incremental) {
            setNetworkEvents((prev) => {
              const existing = new Set(prev.map((e) => `${e.timestamp}-${e.category}-${e.validatorUid}`));
              const fresh = actResult.events.filter((e) => !existing.has(`${e.timestamp}-${e.category}-${e.validatorUid}`));
              const merged = [...fresh, ...prev];
              merged.sort((a, b) => b.timestamp - a.timestamp);
              return merged.slice(0, 2000);
            });
          } else {
            setNetworkEvents(actResult.events);
          }
          setNetworkDiag({ discovered: actResult.validatorsDiscovered, responded: actResult.validatorsResponded, error: actResult.error });
        },
        () => { trackStep(4, "error"); },
      ),
      fetchRecentSignals(50).then(
        (val) => { trackStep(5, "done"); setRecentSignals(val as SubgraphRecentSignal[]); },
        () => { trackStep(5, "error"); },
      ),
      fetchRecentPurchases(50).then(
        (val) => { trackStep(6, "done"); setRecentPurchases(val as SubgraphRecentPurchase[]); },
        () => { trackStep(6, "error"); },
      ),
      fetchRecentAudits(50).then(
        (val) => { trackStep(7, "done"); setRecentAudits(val as SubgraphRecentAudit[]); },
        () => { trackStep(7, "error"); },
      ),
      fetchAttestationData(incremental ? 1 : undefined).then(
        (val) => {
          trackStep(8, "done");
          const newAttest = val as AttestationEntry[];
          if (incremental) {
            setAttestations((prev) => {
              const existingIds = new Set(prev.map((a) => a.id));
              const fresh = newAttest.filter((a) => !existingIds.has(a.id));
              const merged = [...fresh, ...prev];
              merged.sort((a, b) => b.created_at - a.created_at);
              return merged.slice(0, 500);
            });
          } else {
            setAttestations(newAttest);
          }
        },
        () => { trackStep(8, "error"); },
      ),
      fetchTelemetry(sinceTs).then(
        (val) => {
          trackStep(9, "done");
          const newEvents = val as TelemetryEvent[];
          if (incremental) {
            setTelemetryEvents((prev) => {
              const existing = new Set(prev.map((e) => `${e.id}-${e.sourceUid}`));
              const fresh = newEvents.filter((e) => !existing.has(`${e.id}-${e.sourceUid}`));
              const merged = [...fresh, ...prev];
              merged.sort((a, b) => b.timestamp - a.timestamp);
              return merged.slice(0, 2000);
            });
          } else {
            setTelemetryEvents(newEvents);
          }
        },
        () => { trackStep(9, "error"); },
      ),
      fetchFeedback(feedbackFilter).then(
        (val) => { trackStep(10, "done"); setFeedback(val as FeedbackEntry[]); },
        () => { trackStep(10, "error"); },
      ),
      fetchDelegateNames().then(
        (val) => { trackStep(11, "done"); setDelegateNames(val as Record<string, string>); },
        () => { trackStep(11, "error"); },
      ),
    ]);

    lastFetchTs.current = now;
    isFirstLoad.current = false;
    setLastRefresh(new Date());
    setRefreshStep("");
    setRefreshSteps({});
    setLoading(false);
  }, [feedbackFilter]);

  useEffect(() => {
    if (!authed) return;
    refresh();
    // Fetch latest repo version from GitHub (separate, non-blocking)
    fetch("/api/admin/latest-version").then(r => r.ok ? r.json() : null).then(d => { if (d?.version) setRepoVersion(d); }).catch(() => {});
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
  const healthyMiners = miners.filter((m) => m.status === "ok");
  const totalShares = validators.reduce((sum, v) => sum + (v.shares_held || 0), 0);

  // ── Network Health Breakdown ──
  // Validators: running djinn code = has a version string that's not empty
  const djinnValidators = validators.filter((v) => !v.error && v.version && v.version !== "-" && v.version !== "0");
  const attestCapableValidators = validators.filter((v) => !v.error && v.attest_capable);
  const chainConnectedValidators = validators.filter((v) => !v.error && v.chain_connected);
  const btConnectedValidators = validators.filter((v) => !v.error && v.bt_connected);
  const sharesHoldingValidators = validators.filter((v) => !v.error && v.shares_held > 0);

  // Miners: running djinn code = has a non-empty version, odds API connected, BT connected
  const djinnMiners = miners.filter((m) => !m.error && m.version && m.version !== "-" && m.version !== "0");
  const oddsConnectedMiners = miners.filter((m) => !m.error && m.odds_api_connected);
  const btConnectedMiners = miners.filter((m) => !m.error && m.bt_connected);
  const attestCapableMiners = miners.filter((m) => !m.error && m.version && parseInt(m.version, 10) >= 512);
  const fullyOperationalMiners = miners.filter((m) => !m.error && m.status === "ok" && m.odds_api_connected && m.bt_connected && m.version && m.version !== "-" && m.version !== "0");

  const filteredMiners = miners.filter((m) => {
    switch (minerFilter) {
      case "djinn": return !m.error && m.version && m.version !== "-" && m.version !== "0";
      case "healthy": return m.status === "ok";
      case "odds": return !m.error && m.odds_api_connected;
      case "operational": return !m.error && m.status === "ok" && m.odds_api_connected && m.bt_connected && m.version && m.version !== "-" && m.version !== "0";
      default: return true;
    }
  });

  const filteredValidators = validators.filter((v) => {
    switch (validatorFilter) {
      case "djinn": return !v.error && v.version && v.version !== "-" && v.version !== "0";
      case "healthy": return v.status === "ok";
      case "chain": return !v.error && v.chain_connected;
      case "shares": return !v.error && v.shares_held > 0;
      default: return true;
    }
  });

  return (
    <div className="max-w-7xl mx-auto px-2 sm:px-4 py-4 sm:py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">
            Djinn Protocol infrastructure monitoring
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {(() => {
            const allVersions = [
              ...validators.filter(v => v.version && v.version !== "-" && v.version !== "0").map(v => Number(v.version)),
              ...miners.filter(m => m.version && m.version !== "-" && m.version !== "0").map(m => Number(m.version)),
            ].filter(n => !isNaN(n));
            const maxLive = allVersions.length > 0 ? Math.max(...allVersions) : null;
            const latest = repoVersion ? `${repoVersion.version} (${repoVersion.sha})` : process.env.NEXT_PUBLIC_GIT_VERSION || "?";
            const latestNum = repoVersion?.version;
            const behind = latestNum && maxLive ? latestNum - maxLive : null;
            return (
              <span className="text-xs text-slate-400 hidden sm:inline font-mono" title={`Latest on GitHub: v${latest}\nHighest deployed: v${maxLive ?? "?"}\n${behind ? `${behind} commit${behind !== 1 ? "s" : ""} behind` : ""}`}>
                latest v{latest}{maxLive ? <>{" · "}live v{maxLive}{behind && behind > 0 ? <span className="text-amber-500"> ({behind} behind)</span> : <span className="text-green-500"> (up to date)</span>}</> : ""}
              </span>
            );
          })()}
          {lastRefresh && (
            <span className="text-xs text-slate-400 hidden sm:inline">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <div>
            <button
              onClick={async () => {
                await fetch("/api/admin/clear-cache", { method: "POST" });
                refresh();
              }}
              disabled={loading}
              className="px-3 py-1.5 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50"
            >
              {loading && Object.keys(refreshSteps).length > 0
                ? `${Object.values(refreshSteps).filter(s => s === "done").length}/${Object.keys(refreshSteps).length} loaded`
                : loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          {GRAFANA_URL && (
            <a
              href={GRAFANA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 text-sm font-medium bg-genius-600 text-white rounded-lg hover:bg-genius-500"
            >
              Grafana
            </a>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex overflow-x-auto border-b border-slate-200 mb-8 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {(
          [
            ["overview", "Overview"],
            ["network", "Network"],
            ["protocol", "Protocol"],
            ["attestations", "Attest"],
            ["telemetry", "Telemetry"],
            ["feedback", "Feedback"],
            ["metagraph", "Metagraph"],
          ] as const
        ).map(([tab, label]) => {
          const badge = getBadge(tab, {
            networkEvents, recentSignals, recentPurchases, attestations, telemetryEvents, feedback,
          });
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`relative flex-shrink-0 px-3 sm:px-6 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-400 hover:text-slate-600"
              }`}
            >
              {label}
              {badge && (
                <span className={`ml-1.5 inline-flex items-center justify-center text-[10px] font-bold rounded-full min-w-[18px] h-[18px] px-1 ${
                  tab === "feedback"
                    ? "bg-red-500 text-white"
                    : "bg-slate-200 text-slate-600"
                }`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Overview Tab ── */}
      {activeTab === "overview" && (
        <>
          {/* Network Health Summary — tweet-ready stats */}
          <div className="mb-8 bg-gradient-to-r from-slate-900 to-slate-800 rounded-xl p-6 text-white">
            <h2 className="text-lg font-semibold mb-5">Network Health Summary</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Validators Column */}
              <div>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Validators ({validators.length} total)</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Validators responding to /health with a non-zero version string. Confirms they're running Djinn validator software.">
                    <span className="text-slate-400 text-[11px] block mb-1">Running Djinn</span>
                    <span className="text-2xl font-bold">{djinnValidators.length}<span className="text-sm font-normal text-slate-500">/{validators.length}</span></span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Validators whose /health endpoint returns status=ok. Reachable and self-reporting as healthy.">
                    <span className="text-slate-400 text-[11px] block mb-1">Healthy</span>
                    <span className="text-2xl font-bold">{healthyValidators.length}<span className="text-sm font-normal text-slate-500">/{validators.length}</span></span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Validators holding Shamir key shares for signal encryption. May exceed 'Running Djinn' if validators acquired shares before version reporting was added">
                    <span className="text-slate-400 text-[11px] block mb-1">Holding Key Shares</span>
                    <span className="text-2xl font-bold">{sharesHoldingValidators.length}<span className="text-sm font-normal text-slate-500">/{validators.length}</span></span>
                    <span className="text-slate-500 text-[10px] block mt-0.5">{totalShares} shares total</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Validators connected to both Base chain (for on-chain settlement) and Bittensor network (for subnet communication)">
                    <span className="text-slate-400 text-[11px] block mb-1">Chain + BT Connected</span>
                    <span className="text-2xl font-bold">{chainConnectedValidators.length}<span className="text-sm font-normal text-slate-500">/{validators.length}</span></span>
                  </div>
                </div>
              </div>
              {/* Miners Column */}
              <div>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Miners ({miners.length} total)</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Miners responding to /health with a non-zero version string. Confirms they're running Djinn miner software.">
                    <span className="text-slate-400 text-[11px] block mb-1">Running Djinn</span>
                    <span className="text-2xl font-bold">{djinnMiners.length}<span className="text-sm font-normal text-slate-500">/{miners.length}</span></span>
                  </div>
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 cursor-help" title="Miners that pass ALL checks: healthy status, Odds API connected, Bittensor connected, and running Djinn code. These are fully contributing to the network.">
                    <span className="text-green-400 text-[11px] block mb-1">Fully Operational</span>
                    <span className="text-2xl font-bold text-green-400">{fullyOperationalMiners.length}<span className="text-sm font-normal text-green-600">/{miners.length}</span></span>
                    <span className="text-green-600 text-[10px] block mt-0.5">Healthy + Odds + BT + Djinn</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Miners with a live connection to The Odds API. Can fetch real-time sports betting lines for challenge verification.">
                    <span className="text-slate-400 text-[11px] block mb-1">Odds API Connected</span>
                    <span className="text-2xl font-bold">{oddsConnectedMiners.length}<span className="text-sm font-normal text-slate-500">/{miners.length}</span></span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Miners connected to the Bittensor network. Can communicate with validators for challenges and weight setting.">
                    <span className="text-slate-400 text-[11px] block mb-1">BT Connected</span>
                    <span className="text-2xl font-bold">{btConnectedMiners.length}<span className="text-sm font-normal text-slate-500">/{miners.length}</span></span>
                  </div>
                </div>
              </div>
            </div>
            {/* Attestation row */}
            <div className="mt-4 pt-4 border-t border-slate-700">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3 cursor-help" title="Miners running version 512+ which includes TLSNotary prover support. Can generate cryptographic proofs for URL attestation (djinn.gg/attest).">
                  <span className="text-cyan-400 text-[11px] block mb-1">Attest-Capable Miners (v512+)</span>
                  <span className="text-2xl font-bold text-cyan-300">{attestCapableMiners.length}<span className="text-sm font-normal text-cyan-600">/{miners.length}</span></span>
                </div>
                <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg p-3 cursor-help" title="Validators running version 512+ which includes TLSNotary verifier support. Can verify and validate attestation proofs from miners.">
                  <span className="text-cyan-400 text-[11px] block mb-1">Attest-Capable Validators (v512+)</span>
                  <span className="text-2xl font-bold text-cyan-300">{attestCapableValidators.length}<span className="text-sm font-normal text-cyan-600">/{validators.length}</span></span>
                </div>
                <div className="bg-white/5 rounded-lg p-3 cursor-help" title="Nodes registered on the subnet but not responding with Djinn software. May be running generic Bittensor code, offline, or misconfigured.">
                  <span className="text-slate-400 text-[11px] block mb-1">Not Running Djinn</span>
                  <span className="text-2xl font-bold text-slate-500">{miners.length - djinnMiners.length} miners / {validators.length - djinnValidators.length} validators</span>
                </div>
              </div>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
            <StatCard
              label="Validators"
              value={`${healthyValidators.length}/${validators.length}`}
              status={healthyValidators.length >= 7 ? "green" : healthyValidators.length >= 4 ? "yellow" : "red"}
            />
            <StatCard
              label="Miners"
              value={miners.length > 0 ? `${healthyMiners.length}/${miners.length}` : "0"}
              status={healthyMiners.length > 0 ? "green" : miners.length > 0 ? "red" : "yellow"}
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
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h2 className="text-xl font-semibold text-slate-900">
                Validators <span className="text-sm font-normal text-slate-400">({filteredValidators.length}/{validators.length})</span>
                <CopyTableButton onClick={copyValTable} copied={valCopied} />
              </h2>
              <div className="flex flex-wrap gap-1">
                {([
                  ["all", "All"],
                  ["djinn", "Running Djinn"],
                  ["healthy", "Healthy"],
                  ["chain", "Chain Connected"],
                  ["shares", "Holding Shares"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setValidatorFilter(key)}
                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                      validatorFilter === key
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white text-slate-600 border-slate-300 hover:border-slate-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto" ref={valTableRef}>
              <table className="w-full text-sm min-w-[900px]">
                <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10">
                  <tr>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Unique identifier on the subnet">UID</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Delegate name or hotkey prefix">Name</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Axon IP address and port registered on-chain">IP</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Total alpha staked on this validator (α)">Stake</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Validator trust: consensus agreement with other validators on miner weights">VTrust</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Fraction of miner-side emission earned, typically 0 for validators who earn via dividends instead">Incentive</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Alpha earned per day from subnet emission">Emission</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Health check result. Healthy if /health responds OK.">Status</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Software version reported by /health endpoint">Version</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Shamir key shares held for signal encryption">Shares</th>
                    <th className="px-2 sm:px-4 py-3 text-center font-medium" title="Connected to Base chain for settlement">Chain</th>
                    <th className="px-2 sm:px-4 py-3 text-center font-medium" title="Connected to Bittensor network">BT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredValidators.length === 0 && !loading && (
                    <tr>
                      <td colSpan={12} className="px-4 py-8 text-center text-slate-400">
                        {validators.length === 0 ? "No validators discovered" : "No validators match filter"}
                      </td>
                    </tr>
                  )}
                  {filteredValidators.map((v) => (
                    <tr key={v.uid} className="hover:bg-slate-50">
                      <td className="px-2 sm:px-4 py-2 font-mono text-slate-700">
                        {v.ss58Hotkey ? (
                          <a href={`https://taostats.io/accounts/${v.ss58Hotkey}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{v.uid}</a>
                        ) : v.uid}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-xs" title={v.hotkey || ""}>
                        {lookupName(delegateNames, v.hotkey, v.coldkey) ? (
                          <span className="font-semibold text-slate-700">{lookupName(delegateNames, v.hotkey, v.coldkey)}</span>
                        ) : (
                          <span className="font-mono text-slate-400">{truncateHotkey(v.hotkey)}</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{v.ip}:{v.port}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700" title={stakeTooltip(v.alphaStake, v.taoStake)}>{formatStake(v.stake)}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700">{formatVTrust(v.validatorTrust)}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700">{formatU16Pct(v.incentive)}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700">{formatEmission(v.emission)}</td>
                      <td className="px-2 sm:px-4 py-2 whitespace-nowrap">
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
                      <td className="px-2 sm:px-4 py-2 font-mono text-xs text-slate-500">
                        {v.version || "-"}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-slate-700">
                        {v.error ? "-" : v.shares_held}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-center whitespace-nowrap">
                        {v.error ? "-" : v.chain_connected ? (
                          <span className="text-green-500">ok</span>
                        ) : (
                          <span className="text-red-500">no</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-center whitespace-nowrap">
                        {v.error ? "-" : v.bt_connected ? (
                          <span className="text-green-500">ok</span>
                        ) : (
                          <span className="text-red-500">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Miners Grid */}
          <div className="mb-8">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h2 className="text-xl font-semibold text-slate-900">
                Miners <span className="text-sm font-normal text-slate-400">({filteredMiners.length}/{miners.length})</span>
                <CopyTableButton onClick={copyMinerTable} copied={minerCopied} />
              </h2>
              <div className="flex flex-wrap gap-1">
                {([
                  ["all", "All"],
                  ["djinn", "Running Djinn"],
                  ["healthy", "Healthy"],
                  ["odds", "Odds API"],
                  ["operational", "Fully Operational"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setMinerFilter(key)}
                    className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                      minerFilter === key
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-white text-slate-600 border-slate-300 hover:border-slate-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto" ref={minerTableRef}>
              <table className="w-full text-sm min-w-[800px]">
                <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10">
                  <tr>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Unique identifier on the subnet">UID</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Delegate name or hotkey prefix">Name</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Axon IP address and port registered on-chain">IP</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Total alpha staked on this miner (α)">Stake</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Fraction of miner-side emission earned based on validator weight consensus">Incentive</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Alpha earned per day from subnet emission">Emission</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Health check result. Healthy if /health responds OK.">Status</th>
                    <th className="px-2 sm:px-4 py-3 text-left font-medium" title="Software version reported by /health endpoint">Version</th>
                    <th className="px-2 sm:px-4 py-3 text-center font-medium" title="Connected to The Odds API for live sports data">Odds</th>
                    <th className="px-2 sm:px-4 py-3 text-center font-medium" title="Connected to Bittensor network">BT</th>
                    <th className="px-2 sm:px-4 py-3 text-right font-medium" title="Time since miner process started">Uptime</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredMiners.length === 0 && !loading && (
                    <tr>
                      <td colSpan={11} className="px-4 py-8 text-center text-slate-400">
                        {miners.length === 0 ? "No miners discovered" : "No miners match filter"}
                      </td>
                    </tr>
                  )}
                  {filteredMiners.map((m) => (
                    <tr key={m.uid} className="hover:bg-slate-50">
                      <td className="px-2 sm:px-4 py-2 font-mono text-slate-700">
                        {m.ss58Hotkey ? (
                          <a href={`https://taostats.io/accounts/${m.ss58Hotkey}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{m.uid}</a>
                        ) : m.uid}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-xs" title={m.hotkey || ""}>
                        {lookupName(delegateNames, m.hotkey, m.coldkey) ? (
                          <span className="font-semibold text-slate-700">{lookupName(delegateNames, m.hotkey, m.coldkey)}</span>
                        ) : (
                          <span className="font-mono text-slate-400">{truncateHotkey(m.hotkey)}</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 font-mono text-xs text-slate-500 whitespace-nowrap">{m.ip}:{m.port}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700" title={stakeTooltip(m.alphaStake, m.taoStake)}>{formatStake(m.stake)}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700">{formatU16Pct(m.incentive)}</td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-xs text-slate-700">{formatEmission(m.emission)}</td>
                      <td className="px-2 sm:px-4 py-2 whitespace-nowrap">
                        {m.error ? (
                          <span className="inline-flex items-center gap-1 text-red-600">
                            <Dot color="red" /> Unreachable
                          </span>
                        ) : m.status === "ok" ? (
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <Dot color="green" /> Healthy
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-yellow-600">
                            <Dot color="yellow" /> {m.status}
                          </span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 font-mono text-xs text-slate-500">
                        {m.version || "-"}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-center whitespace-nowrap">
                        {m.error ? "-" : m.odds_api_connected ? (
                          <span className="text-green-500">ok</span>
                        ) : (
                          <span className="text-red-500">no</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-center whitespace-nowrap">
                        {m.error ? "-" : m.bt_connected ? (
                          <span className="text-green-500">ok</span>
                        ) : (
                          <span className="text-red-500">no</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-4 py-2 text-right font-mono text-sm text-slate-700 whitespace-nowrap">
                        {m.error ? "-" : formatUptime(m.uptime_seconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Protocol Stats */}
          {stats && (
            <div className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Protocol Statistics</h2>
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-6 grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6">
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

          {/* Network Metrics Charts */}
          <MetricsCharts validators={validators.filter((v) => v.attest_capable)} />

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

          {/* Miner Lookup */}
          <MinerLookup />
        </>
      )}

      {/* ── Network Tab (Miners & Validators Activity) ── */}
      {activeTab === "network" && (
        <NetworkActivityTab events={networkEvents} loading={loading} diag={networkDiag} fetchStatus={validatorFetchStatus} />
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
          loading={loading}
          validators={validators}
        />
      )}

      {activeTab === "telemetry" && (
        <TelemetryTab events={telemetryEvents} loading={loading} />
      )}

      {activeTab === "feedback" && (
        <FeedbackTab
          feedback={feedback}
          filter={feedbackFilter}
          onFilterChange={(f) => { setFeedbackFilter(f); }}
          loading={loading}
        />
      )}

      {activeTab === "metagraph" && <MetagraphTab />}
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

function MinerResultTable({ miners, columns }: { miners: Array<Record<string, unknown>>; columns: { key: string; label: string; align?: string }[] }) {
  if (!miners || miners.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-slate-500">
            {columns.map((col) => (
              <th key={col.key} className={`px-2 py-1 font-medium ${col.align === "right" ? "text-right" : "text-left"}`}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100/50">
          {miners.map((m, i) => (
            <tr key={i}>
              {columns.map((col) => (
                <td key={col.key} className={`px-2 py-1 font-mono ${col.align === "right" ? "text-right" : "text-left"} ${
                  col.key === "error" ? "text-red-600" : col.key === "correct" || col.key === "valid"
                    ? m[col.key] ? "text-green-700" : "text-red-600"
                    : "text-slate-700"
                }`}>
                  {formatDetailValue(m[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Extract burn value from summary like "Set weights for 153 miners (burn=0.95)" */
function parseBurnFromSummary(summary: string): string | null {
  const m = summary.match(/burn=([0-9.]+)/);
  return m ? `${(parseFloat(m[1]) * 100).toFixed(0)}%` : null;
}

/** Render all known fields from details as a key-value grid, skipping arrays and listed keys */
function DetailGrid({ details, skip, color }: { details: Record<string, unknown>; skip?: Set<string>; color: string }) {
  const entries = Object.entries(details).filter(
    ([k, v]) => !Array.isArray(v) && !(skip?.has(k))
  );
  if (entries.length === 0) return null;
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3`}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span className={`text-${color}-600 font-medium block`}>{k.replace(/_/g, " ")}</span>
          <span className={`text-${color}-900 font-mono`}>{formatDetailValue(v)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miner Lookup — query all validators for a miner's live scoring metrics
// ---------------------------------------------------------------------------

interface MinerScoreResult {
  validatorUid: number;
  found: boolean;
  hotkey?: string;
  accuracy?: number;
  coverage?: number;
  uptime?: number;
  attest_validity?: number;
  queries_total?: number;
  queries_correct?: number;
  proofs_submitted?: number;
  attestations_total?: number;
  attestations_valid?: number;
  health_checks_total?: number;
  health_checks_responded?: number;
  consecutive_epochs?: number;
  notary_duties_assigned?: number;
  notary_duties_completed?: number;
  notary_reliability?: number;
}

function MinerLookup() {
  const [uid, setUid] = useState("");
  const [results, setResults] = useState<MinerScoreResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  async function lookup() {
    const parsed = parseInt(uid.trim(), 10);
    if (isNaN(parsed) || parsed < 0) return;
    setSearching(true);
    setSearched(true);
    try {
      const discoverRes = await fetch("/api/validators/discover");
      if (!discoverRes.ok) { setResults([]); return; }
      const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };
      const fetches = await Promise.allSettled(
        validators.map(async (v) => {
          const res = await fetch(`/api/validators/${v.uid}/v1/miner/${parsed}/scores`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) return { validatorUid: v.uid, found: false } as MinerScoreResult;
          const data = await res.json();
          return { ...data, validatorUid: v.uid } as MinerScoreResult;
        }),
      );
      setResults(
        fetches
          .filter((r) => r.status === "fulfilled")
          .map((r) => (r as PromiseFulfilledResult<MinerScoreResult>).value),
      );
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  const found = results.filter((r) => r.found);

  return (
    <div>
      <h2 className="text-xl font-semibold text-slate-900 mb-4">Miner Lookup</h2>
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Enter miner UID"
              value={uid}
              onChange={(e) => setUid(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && lookup()}
              className="px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-lg bg-white w-32 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <button
              onClick={lookup}
              disabled={searching || !uid.trim()}
              className="px-3 py-1.5 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {searching ? "Searching..." : "Lookup"}
            </button>
            <span className="text-xs text-slate-400">Queries all validators for live miner metrics</span>
          </div>
        </div>
        {searched && (
          <div className="p-4">
            {found.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-4">
                {searching ? "Querying validators..." : `No validator has metrics for UID ${uid}`}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-200">
                      <th className="px-2 py-1.5 text-left font-medium">Validator</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Accuracy (sports)">Acc</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Coverage (sports)">Cov</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Uptime">Up</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Attestation validity">A.Val</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Queries correct / total">Queries</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Attestations valid / total">Attests</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Health checks responded / total">Health</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Notary duties completed / assigned">Notary</th>
                      <th className="px-2 py-1.5 text-right font-medium" title="Consecutive epochs">Epochs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {found.map((r) => (
                      <tr key={r.validatorUid}>
                        <td className="px-2 py-1.5 font-mono text-slate-700">v{r.validatorUid}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-700">{fmtPct(r.accuracy)}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-700">{fmtPct(r.coverage)}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-700">{fmtPct(r.uptime)}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-700">{fmtPct(r.attest_validity)}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-400">{r.queries_correct}/{r.queries_total}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-400">{r.attestations_valid}/{r.attestations_total}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-400">{r.health_checks_responded}/{r.health_checks_total}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-400">{r.notary_duties_completed ?? 0}/{r.notary_duties_assigned ?? 0}{r.notary_reliability !== undefined && r.notary_duties_assigned ? <span className="text-cyan-600 ml-1">({fmtPct(r.notary_reliability)})</span> : ""}</td>
                        <td className="px-2 py-1.5 font-mono text-right text-slate-400">{r.consecutive_epochs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {found[0]?.hotkey && (
                  <div className="mt-2 text-[10px] text-slate-400 font-mono truncate">
                    Hotkey: {found[0].hotkey}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WeightSetDetail({ event }: { event: NetworkEvent }) {
  const d = event.details || {};
  const topMiners = (d.top_miners as Array<Record<string, unknown>>) || [];
  const totalMiners = (d.total_miners as number) || topMiners.length;
  const burnStr = d.burn_fraction !== undefined
    ? `${(Number(d.burn_fraction) * 100).toFixed(0)}%`
    : parseBurnFromSummary(event.summary);
  const [uidFilter, setUidFilter] = useState("");

  // Check if we have component breakdowns (new format)
  const hasBreakdown = topMiners.length > 0 && topMiners[0].accuracy !== undefined;

  const filtered = uidFilter.trim()
    ? topMiners.filter((m) => String(m.uid) === uidFilter.trim())
    : topMiners;

  return (
    <div className="mx-4 mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
        <div>
          <span className="text-amber-600 font-medium block">Miners</span>
          <span className="text-amber-900 font-mono">{formatDetailValue(d.n_miners)}</span>
        </div>
        <div>
          <span className="text-amber-600 font-medium block">Burn</span>
          <span className="text-amber-900 font-mono">{burnStr || "-"}</span>
        </div>
        <div>
          <span className="text-amber-600 font-medium block">Active Signals</span>
          <span className={`font-mono ${d.is_active ? "text-green-700" : "text-amber-900"}`}>{d.is_active ? "Yes" : "No"}</span>
        </div>
        <div>
          <span className="text-amber-600 font-medium block">Time</span>
          <span className="text-amber-900">{formatTimeAgo(event.timestamp)}</span>
        </div>
      </div>
      {topMiners.length > 0 ? (
        <>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="text"
              placeholder="Search UID..."
              value={uidFilter}
              onChange={(e) => setUidFilter(e.target.value)}
              className="px-2 py-1 text-[11px] font-mono border border-amber-300 rounded bg-white w-24 focus:outline-none focus:ring-1 focus:ring-amber-400"
            />
            <span className="text-[10px] text-slate-400">
              Showing {filtered.length} of {topMiners.length}{totalMiners > topMiners.length ? ` (${totalMiners} total)` : ""}
            </span>
          </div>
          {hasBreakdown ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-slate-500">
                    <th className="px-2 py-1 text-left font-medium">UID</th>
                    <th className="px-2 py-1 text-right font-medium">Weight</th>
                    <th className="px-2 py-1 text-right font-medium" title="Accuracy (sports)">Acc</th>
                    <th className="px-2 py-1 text-right font-medium" title="Speed (sports)">Spd</th>
                    <th className="px-2 py-1 text-right font-medium" title="Coverage (sports)">Cov</th>
                    <th className="px-2 py-1 text-right font-medium" title="Uptime">Up</th>
                    <th className="px-2 py-1 text-right font-medium" title="Attestation validity">A.Val</th>
                    <th className="px-2 py-1 text-right font-medium" title="Queries total">Q</th>
                    <th className="px-2 py-1 text-right font-medium" title="Attestations total">Att</th>
                    <th className="px-2 py-1 text-right font-medium" title="Health checks responded">HC</th>
                    <th className="px-2 py-1 text-right font-medium" title="Consecutive epochs">Ep</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100/50">
                  {filtered.map((m, i) => {
                    const hasActivity = Number(m.queries_total) > 0 || Number(m.attestations_total) > 0;
                    const w = fmtWeight(m.weight);
                    return (
                      <tr key={i} className={hasActivity ? "bg-amber-100/30" : ""}>
                        <td className="px-2 py-1 font-mono text-slate-700">{formatDetailValue(m.uid)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700 cursor-default" title={w.tooltip ?? undefined}>{w.display}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700">{fmtPct(m.accuracy)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700">{fmtPct(m.speed)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700">{fmtPct(m.coverage)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700">{fmtPct(m.uptime)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-700">{fmtPct(m.attest_validity)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-400">{formatDetailValue(m.queries_total)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-400">{formatDetailValue(m.attestations_total)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-400">{formatDetailValue(m.health_responded)}</td>
                        <td className="px-2 py-1 font-mono text-right text-slate-400">{formatDetailValue(m.consecutive_epochs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <MinerResultTable miners={filtered} columns={[
              { key: "uid", label: "UID" },
              { key: "weight", label: "Weight", align: "right" },
            ]} />
          )}
        </>
      ) : (
        <div className="text-[10px] text-slate-400 italic">Validator update required for per-miner weight breakdown</div>
      )}
    </div>
  );
}

/** Format a 0-1 score as percentage, showing "-" for zero */
function fmtPct(v: unknown): string {
  const n = Number(v);
  if (!n || isNaN(n)) return "-";
  return `${(n * 100).toFixed(1)}%`;
}

/** Format a weight value — full decimal, never scientific notation. */
function fmtWeight(v: unknown): { display: string; tooltip: string | null } {
  const n = Number(v);
  if (!n || isNaN(n)) return { display: "-", tooltip: null };
  // Full decimal: enough digits to distinguish weights (up to 10 significant)
  const display = n.toFixed(Math.max(2, -Math.floor(Math.log10(Math.abs(n))) + 3));
  // Reciprocal fraction tooltip when denominator is close to an integer
  const recip = 1 / n;
  const rounded = Math.round(recip);
  let tooltip: string | null = null;
  if (rounded >= 2 && Math.abs(recip - rounded) / rounded < 0.01) {
    tooltip = `≈ 1/${rounded}`;
  }
  return { display, tooltip };
}

function EventDetailPanel({ event }: { event: NetworkEvent }) {
  const d = event.details || {};
  const cat = event.category;

  if (cat === "health_check") {
    const failedUids = (d.failed_uids as number[]) || [];
    const responded = d.responded as number | undefined;
    const total = d.total as number | undefined;
    const failedCount = (total !== undefined && responded !== undefined) ? total - responded : 0;
    return (
      <div className="mx-4 mb-3 p-3 bg-green-50 border border-green-200 rounded-lg text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <span className="text-green-600 font-medium block">Responded</span>
            <span className="text-green-900 font-mono">{formatDetailValue(responded)}/{formatDetailValue(total)}</span>
          </div>
          <div>
            <span className="text-green-600 font-medium block">Response Rate</span>
            <span className="text-green-900 font-mono">
              {responded !== undefined && total ? `${((responded / total) * 100).toFixed(1)}%` : "-"}
            </span>
          </div>
          <div>
            <span className="text-green-600 font-medium block">Time</span>
            <span className="text-green-900">{formatTimeAgo(event.timestamp)}</span>
          </div>
          <div>
            <span className="text-red-500 font-medium block">Failed</span>
            <span className="text-red-700 font-mono">{failedCount}</span>
          </div>
        </div>
        {failedUids.length > 0 && (
          <div className="mt-2">
            <span className="text-red-500 font-medium block">Failed UIDs</span>
            <span className="text-red-700 font-mono text-[10px] break-all">{failedUids.slice(0, 50).join(", ")}{failedUids.length > 50 ? ` ...+${failedUids.length - 50} more` : ""}</span>
          </div>
        )}
        {failedUids.length === 0 && failedCount > 0 && (
          <div className="mt-2 text-[10px] text-slate-400 italic">
            Validator update required for per-miner failed UID breakdown
          </div>
        )}
      </div>
    );
  }

  if (cat === "weight_set") {
    return <WeightSetDetail event={event} />;
  }

  if (cat === "attestation_challenge") {
    const miners = (d.miners as Array<Record<string, unknown>>) || [];
    // Support both old format (miners_challenged) and new format (challenged/verified/url/miners)
    const challenged = d.challenged ?? d.miners_challenged;
    return (
      <div className="mx-4 mb-3 p-3 bg-cyan-50 border border-cyan-200 rounded-lg text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-2">
          {d.reachable !== undefined && (
            <div>
              <span className="text-cyan-600 font-medium block">Reachable</span>
              <span className="text-cyan-900 font-mono">{formatDetailValue(d.reachable)}</span>
            </div>
          )}
          {d.capable !== undefined && (
            <div>
              <span className="text-cyan-600 font-medium block">Capable</span>
              <span className="text-cyan-900 font-mono">{formatDetailValue(d.capable)}</span>
            </div>
          )}
          <div>
            <span className="text-cyan-600 font-medium block">Challenged</span>
            <span className="text-cyan-900 font-mono">{formatDetailValue(challenged)}</span>
          </div>
          {d.verified !== undefined && (
            <div>
              <span className="text-cyan-600 font-medium block">Verified</span>
              <span className="text-cyan-900 font-mono">{formatDetailValue(d.verified)}</span>
            </div>
          )}
          {typeof d.url === "string" && (
            <div className="col-span-2 sm:col-span-1">
              <span className="text-cyan-600 font-medium block">URL</span>
              <span className="text-cyan-900 font-mono truncate block">{d.url.replace(/^https?:\/\//, "").slice(0, 40)}</span>
            </div>
          )}
          {d.peer_notarized !== undefined && (
            <div>
              <span className="text-cyan-600 font-medium block">Peer Notarized</span>
              <span className="text-cyan-900 font-mono">{formatDetailValue(d.peer_notarized)}</span>
            </div>
          )}
          <div>
            <span className="text-cyan-600 font-medium block">Time</span>
            <span className="text-cyan-900">{formatTimeAgo(event.timestamp)}</span>
          </div>
        </div>
        {miners.length > 0 ? (
          <MinerResultTable miners={miners} columns={[
            { key: "uid", label: "Prover" },
            { key: "notary_uid", label: "Notary" },
            { key: "valid", label: "Valid" },
            { key: "latency", label: "Latency (s)", align: "right" },
            { key: "server", label: "Server" },
            { key: "error", label: "Error" },
          ]} />
        ) : (
          <div className="text-[10px] text-slate-400 italic">Validator update required for per-miner attestation breakdown</div>
        )}
      </div>
    );
  }

  if (cat === "challenge_round") {
    const miners = (d.miners as Array<Record<string, unknown>>) || [];
    return (
      <div className="mx-4 mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-2">
          {d.sport !== undefined ? (
            <div>
              <span className="text-blue-600 font-medium block">Sport</span>
              <span className="text-blue-900 font-mono">{formatDetailValue(d.sport)}</span>
            </div>
          ) : null}
          {d.games_found !== undefined && (
            <div>
              <span className="text-blue-600 font-medium block">Games</span>
              <span className="text-blue-900 font-mono">{formatDetailValue(d.games_found)}</span>
            </div>
          )}
          {d.lines_used !== undefined && (
            <div>
              <span className="text-blue-600 font-medium block">Lines</span>
              <span className="text-blue-900 font-mono">{formatDetailValue(d.lines_used)}</span>
            </div>
          )}
          <div>
            <span className="text-blue-600 font-medium block">Miners Challenged</span>
            <span className="text-blue-900 font-mono">{formatDetailValue(d.miners_challenged)}</span>
          </div>
          {d.responding !== undefined && (
            <div>
              <span className="text-blue-600 font-medium block">Responding</span>
              <span className="text-blue-900 font-mono">{formatDetailValue(d.responding)}</span>
            </div>
          )}
          {d.consensus_quorum !== undefined && (
            <div>
              <span className="text-blue-600 font-medium block">Quorum</span>
              <span className="text-blue-900">{formatDetailValue(d.consensus_quorum)}</span>
            </div>
          )}
          {(d.proofs_requested as number) > 0 && (
            <div>
              <span className="text-blue-600 font-medium block">Proofs</span>
              <span className="text-blue-900 font-mono">{formatDetailValue(d.proofs_submitted)}/{formatDetailValue(d.proofs_requested)}</span>
            </div>
          )}
          <div>
            <span className="text-blue-600 font-medium block">Time</span>
            <span className="text-blue-900">{formatTimeAgo(event.timestamp)}</span>
          </div>
        </div>
        {miners.length > 0 ? (
          <MinerResultTable miners={miners} columns={[
            { key: "uid", label: "UID" },
            { key: "correct", label: "Correct" },
            { key: "accuracy", label: "Accuracy", align: "right" },
            { key: "available", label: "Lines", align: "right" },
            { key: "latency", label: "Latency (s)", align: "right" },
            { key: "proof_valid", label: "Proof" },
            { key: "error", label: "Error" },
          ]} />
        ) : (
          <div className="text-[10px] text-slate-400 italic">Validator update required for per-miner challenge breakdown</div>
        )}
      </div>
    );
  }

  if (cat === "outcome_resolution") {
    const signalIds = (d.signal_ids as string[]) || [];
    return (
      <div className="mx-4 mb-3 p-3 bg-purple-50 border border-purple-200 rounded-lg text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
          <div>
            <span className="text-purple-600 font-medium block">Signals Resolved</span>
            <span className="text-purple-900 font-mono">{formatDetailValue(d.count)}</span>
          </div>
          <div>
            <span className="text-purple-600 font-medium block">Time</span>
            <span className="text-purple-900">{formatTimeAgo(event.timestamp)}</span>
          </div>
        </div>
        {signalIds.length > 0 ? (
          <div>
            <span className="text-purple-600 font-medium block mb-1">Signal IDs</span>
            <div className="flex flex-wrap gap-1">
              {signalIds.map((id) => (
                <span key={id} className="px-1.5 py-0.5 bg-purple-100 text-purple-800 font-mono text-[10px] rounded">
                  {id.length > 12 ? `${id.slice(0, 8)}...` : id}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-[10px] text-slate-400 italic">Validator update required for signal ID breakdown</div>
        )}
      </div>
    );
  }

  // Generic fallback: show all non-array fields in a key-value grid
  const entries = Object.entries(d).filter(([, v]) => !Array.isArray(v));
  if (entries.length === 0) {
    return (
      <div className="mx-4 mb-3 p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className="text-slate-500 font-medium block">Summary</span>
            <span className="text-slate-800">{event.summary}</span>
          </div>
          <div>
            <span className="text-slate-500 font-medium block">Time</span>
            <span className="text-slate-800">{formatTimeAgo(event.timestamp)}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-4 mb-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {entries.map(([k, v]) => (
          <div key={k}>
            <span className="text-slate-500 font-medium block">{k.replace(/_/g, " ")}</span>
            <span className="text-slate-800 font-mono">{formatDetailValue(v)}</span>
          </div>
        ))}
        <div>
          <span className="text-slate-500 font-medium block">Time</span>
          <span className="text-slate-800">{formatTimeAgo(event.timestamp)}</span>
        </div>
      </div>
    </div>
  );
}

function NetworkActivityTab({ events, loading, diag, fetchStatus }: { events: NetworkEvent[]; loading: boolean; diag: { discovered: number; responded: number; error?: string } | null; fetchStatus: Record<number, "pending" | "success" | "error"> }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [validatorFilter, setValidatorFilter] = useState<number | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (loading && events.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading network activity...</div>;
  }

  const afterValidator = validatorFilter !== null ? events.filter((e) => e.validatorUid === validatorFilter) : events;
  const filtered = filter ? afterValidator.filter((e) => e.category === filter) : afterValidator;
  const categories = [...new Set(events.map((e) => e.category))];
  const validatorUids = [...new Set(events.map((e) => e.validatorUid).filter((u) => u !== undefined))].sort((a, b) => (a as number) - (b as number));

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <h3 className="text-sm font-medium text-slate-700">
          Validator &amp; Miner Activity
          <span className="ml-2 text-xs text-slate-400">({filtered.length}{filter || validatorFilter !== null ? ` of ${events.length}` : ""} events)</span>
        </h3>
        {diag && (
          <p className="text-[11px] text-slate-400 mt-1">
            {diag.discovered} validator{diag.discovered !== 1 ? "s" : ""} discovered, {diag.responded} responded
            {diag.error && <span className="text-red-400 ml-2">{diag.error}</span>}
          </p>
        )}
        {Object.keys(fetchStatus).length > 0 && (
          <div className="flex items-center gap-2 mt-1.5">
            {Object.entries(fetchStatus)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([uid, st]) => (
                <div key={uid} className="flex items-center gap-1" title={`v${uid}: ${st}`}>
                  <span className={`inline-block w-2 h-2 rounded-full ${
                    st === "success" ? "bg-green-500" : st === "error" ? "bg-red-500" : "bg-amber-400 animate-pulse"
                  }`} />
                  <span className={`text-[10px] font-mono ${st === "pending" ? "text-amber-600" : "text-slate-400"}`}>
                    {uid}
                  </span>
                </div>
              ))}
          </div>
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
        {validatorUids.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <span className="text-[10px] text-slate-400 py-0.5">Validator:</span>
            <button
              onClick={() => setValidatorFilter(null)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                validatorFilter === null ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500 hover:bg-slate-300"
              }`}
            >
              All
            </button>
            {validatorUids.map((uid) => (
              <button
                key={uid}
                onClick={() => setValidatorFilter(validatorFilter === uid ? null : (uid as number))}
                className={`px-2 py-0.5 text-[10px] font-medium font-mono rounded transition-colors ${
                  validatorFilter === uid ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500 hover:bg-slate-300"
                }`}
              >
                v{uid}
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
          {filtered.map((event, i) => {
            const isExpanded = expandedIdx === i;
            const hasDetails = Object.keys(event.details || {}).length > 0;
            return (
              <div key={i} className="hover:bg-slate-50">
                <button
                  onClick={() => hasDetails && setExpandedIdx(isExpanded ? null : i)}
                  className={`w-full px-4 py-3 text-left ${hasDetails ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {hasDetails && (
                        <span className={`text-slate-400 text-[10px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                          &#9654;
                        </span>
                      )}
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
                      {formatTimeAgo(event.timestamp)}
                    </span>
                  </div>
                </button>
                {isExpanded && <EventDetailPanel event={event} />}
              </div>
            );
          })}
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
            title={`Batch ${a.cycle} \u2014 ${truncAddr(a.genius.id)} / ${truncAddr(a.idiot.id)}`}
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

interface TestAttestResult {
  success: boolean;
  verified?: boolean;
  miner_uid?: number;
  notary_uid?: number | null;
  server_name?: string;
  elapsed_s?: number;
  error?: string;
  proof_hex?: string;
  response_body?: string;
}

function TestResultViewer({ result }: { result: TestAttestResult }) {
  const [viewMode, setViewMode] = useState<"source" | "preview">("source");
  const proofSize = result.proof_hex ? result.proof_hex.length / 2 : 0;
  const hasBody = !!result.response_body;

  const handleDownload = () => {
    if (!result.proof_hex) return;
    const matches = result.proof_hex.match(/.{1,2}/g);
    if (!matches) return;
    const bytes = new Uint8Array(matches.map((b) => parseInt(b, 16)));
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attestation-${Date.now()}.bin`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className={`rounded-lg border text-xs ${result.success ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${result.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
            {result.success ? "SUCCESS" : "FAILED"}
          </span>
          {result.success && result.verified !== undefined && (
            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${result.verified ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
              {result.verified ? "VERIFIED" : "UNVERIFIED"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
          {result.miner_uid !== undefined && (
            <div>
              <span className="text-slate-500 block">Prover</span>
              <span className="text-slate-800 font-mono">UID {result.miner_uid}</span>
            </div>
          )}
          <div>
            <span className="text-slate-500 block">Notary</span>
            {result.notary_uid != null ? (
              <span className="text-cyan-600 font-mono">UID {result.notary_uid}</span>
            ) : (
              <span className="text-slate-400 font-mono">PSE</span>
            )}
          </div>
          {result.server_name && (
            <div>
              <span className="text-slate-500 block">Server</span>
              <span className="text-slate-800 font-mono">{result.server_name}</span>
            </div>
          )}
          {result.elapsed_s !== undefined && (
            <div>
              <span className="text-slate-500 block">Latency</span>
              <span className="text-slate-800 font-mono">{result.elapsed_s}s</span>
            </div>
          )}
          {proofSize > 0 && (
            <div>
              <span className="text-slate-500 block">Proof Size</span>
              <span className="text-slate-800 font-mono">{proofSize.toLocaleString()} bytes</span>
            </div>
          )}
          {hasBody && (
            <div>
              <span className="text-slate-500 block">Response</span>
              <span className="text-slate-800 font-mono">{result.response_body!.length.toLocaleString()} chars</span>
            </div>
          )}
          {result.error && (
            <div className="col-span-2">
              <span className="text-red-500 block">Error</span>
              <span className="text-red-700 font-mono">{result.error}</span>
            </div>
          )}
        </div>
        {result.proof_hex && (
          <button
            onClick={handleDownload}
            className="mt-2 px-3 py-1 text-[10px] font-medium border border-slate-300 rounded-md text-slate-600 hover:bg-white"
          >
            Download proof
          </button>
        )}
      </div>

      {/* Response body viewer */}
      {hasBody && (
        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-slate-700">Response Content</h4>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              <button
                onClick={() => setViewMode("source")}
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  viewMode === "source"
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                Source
              </button>
              <button
                onClick={() => setViewMode("preview")}
                className={`px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  viewMode === "preview"
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                Preview
              </button>
            </div>
          </div>
          {viewMode === "preview" && (
            <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 mb-2">
              Preview only. External resources (CSS, images, scripts) are not included in the proof.
            </p>
          )}
          {viewMode === "source" ? (
            <pre className="bg-slate-800 text-slate-100 rounded-lg p-3 text-[10px] overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
              {result.response_body}
            </pre>
          ) : (
            <iframe
              srcDoc={result.response_body!}
              sandbox=""
              className="w-full rounded-lg border border-slate-200 bg-white"
              style={{ height: "400px" }}
              title="Attested page preview"
            />
          )}
        </div>
      )}
    </div>
  );
}

function AttestationsTab({
  attestations,
  loading,
  validators,
}: {
  attestations: AttestationEntry[];
  loading: boolean;
  validators: ValidatorHealth[];
}) {
  const [testUrl, setTestUrl] = useState("");
  const [testUid, setTestUid] = useState<number | "">("");
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<TestAttestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const runTest = async () => {
    if (!testUrl || testUid === "" || testRunning) return;
    setTestRunning(true);
    setTestResult(null);
    setTestError(null);
    const requestId = `admin-test-${Date.now()}`;
    try {
      const res = await fetch(`/api/validators/${testUid}/v1/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: testUrl, request_id: requestId }),
        signal: AbortSignal.timeout(300_000), // 5 min
      });
      const data = await res.json();
      if (!res.ok) {
        setTestError(data.error || `HTTP ${res.status}`);
      } else {
        setTestResult(data);
      }
    } catch (err) {
      setTestError(String(err));
    } finally {
      setTestRunning(false);
    }
  };

  if (loading && attestations.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading attestation data...</div>;
  }

  const successCount = attestations.filter((a) => a.success).length;
  const verifiedCount = attestations.filter((a) => a.verified).length;
  const centralizedFallbacks = attestations.filter((a) => a.notary_uid === null && a.success);
  const lastCentralized = centralizedFallbacks.length > 0
    ? Math.max(...centralizedFallbacks.map((a) => a.created_at))
    : null;
  const peerNotarized = attestations.filter((a) => a.notary_uid !== null).length;
  const reachableValidators = validators.filter((v) => !v.error);

  return (
    <div className="space-y-8">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-cyan-200 bg-cyan-50 p-4">
          <div className="text-xs text-cyan-600 font-medium">Total Requests</div>
          <div className="text-2xl font-bold text-cyan-900 mt-1">{attestations.length}</div>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-xs text-emerald-600 font-medium">Successful</div>
          <div className="text-2xl font-bold text-emerald-900 mt-1">{successCount}</div>
        </div>
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="text-xs text-blue-600 font-medium">Verified</div>
          <div className="text-2xl font-bold text-blue-900 mt-1">{verifiedCount}</div>
        </div>
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-4">
          <div className="text-xs text-purple-600 font-medium">Success Rate</div>
          <div className="text-2xl font-bold text-purple-900 mt-1">
            {attestations.length > 0
              ? `${((successCount / attestations.length) * 100).toFixed(0)}%`
              : "\u2014"}
          </div>
        </div>
      </div>

      {/* Centralized Notary Fallback Tracker */}
      <div className={`rounded-xl border p-4 ${centralizedFallbacks.length === 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-xs font-medium ${centralizedFallbacks.length === 0 ? "text-emerald-600" : "text-amber-600"}`}>
              Centralized Notary Fallback (notary.pse.dev)
            </div>
            <div className={`text-2xl font-bold mt-1 ${centralizedFallbacks.length === 0 ? "text-emerald-900" : "text-amber-900"}`}>
              {centralizedFallbacks.length} <span className="text-sm font-normal">/ {attestations.length} attestations</span>
            </div>
            <div className="text-xs mt-1 text-slate-500">
              Peer notarized: {peerNotarized}
              {lastCentralized ? (
                <> &middot; Last centralized: {new Date(lastCentralized * 1000).toLocaleDateString()}{" "}
                  {(() => {
                    const daysAgo = Math.floor((Date.now() / 1000 - lastCentralized) / 86400);
                    return daysAgo >= 7
                      ? <span className="text-emerald-600 font-medium">({daysAgo}d ago, safe to remove from codebase)</span>
                      : <span className="text-amber-600">({daysAgo}d ago)</span>;
                  })()}
                </>
              ) : (
                <> &middot; <span className="text-emerald-600 font-medium">Never used, safe to remove from codebase</span></>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Test Attestation Panel */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-sm font-medium text-slate-700">Test Attestation</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">Send a test attestation request to a validator. The validator will pick a prover miner and assign a peer notary to generate a TLSNotary proof.</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="url"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              placeholder="https://httpbin.org/get"
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <select
              value={testUid}
              onChange={(e) => setTestUid(e.target.value ? Number(e.target.value) : "")}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select validator...</option>
              {reachableValidators.map((v) => (
                <option key={v.uid} value={v.uid}>
                  UID {v.uid} ({v.ip}:{v.port}) {v.version ? `v${v.version}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={runTest}
              disabled={!testUrl || testUid === "" || testRunning}
              className="px-4 py-2 text-sm font-medium bg-cyan-600 text-white rounded-lg hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {testRunning ? "Running..." : "Run Test"}
            </button>
          </div>

          {testRunning && (
            <div className="p-3 bg-cyan-50 border border-cyan-200 rounded-lg text-xs text-cyan-700">
              Attestation in progress... This may take up to 2 minutes while the prover generates a TLSNotary proof via a peer notary.
            </div>
          )}

          {testResult && <TestResultViewer result={testResult} />}

          {testError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
              {testError}
            </div>
          )}
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
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Verified</th>
                  <th className="px-3 py-2 font-medium">Prover</th>
                  <th className="px-3 py-2 font-medium">Notary</th>
                  <th className="px-3 py-2 font-medium">Server</th>
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
                      <td className="px-3 py-2 max-w-[200px] truncate">
                        <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800" title={a.url}>
                          {a.url.replace(/^https?:\/\//, "").slice(0, 40)}
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
                          <span className="text-slate-300">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-600">
                        {a.miner_uid !== null ? `UID ${a.miner_uid}` : "\u2014"}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-600">
                        {a.notary_uid !== null ? <span className="text-cyan-600">UID {a.notary_uid}</span> : <span className="text-slate-300">PSE</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {a.server_name || "\u2014"}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-600">
                        {a.elapsed_s !== null ? `${a.elapsed_s}s` : "\u2014"}
                      </td>
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
// Feedback Tab
// ---------------------------------------------------------------------------

const SOURCE_COLORS: Record<string, string> = {
  "error-boundary": "bg-red-100 text-red-700",
  "report-button": "bg-blue-100 text-blue-700",
  "api-error": "bg-amber-100 text-amber-700",
  other: "bg-slate-100 text-slate-600",
};

function FeedbackTab({
  feedback,
  filter,
  onFilterChange,
  loading,
}: {
  feedback: FeedbackEntry[];
  filter: "all" | "open" | "closed";
  onFilterChange: (f: "all" | "open" | "closed") => void;
  loading: boolean;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (loading && feedback.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading feedback...</div>;
  }

  const crashes = feedback.filter((f) => f.labels.includes("crash")).length;
  const openCount = feedback.filter((f) => f.state === "open").length;

  return (
    <div className="space-y-8">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <div className="text-xs text-blue-600 font-medium">Total Reports</div>
          <div className="text-2xl font-bold text-blue-900 mt-1">{feedback.length}</div>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="text-xs text-amber-600 font-medium">Open</div>
          <div className="text-2xl font-bold text-amber-900 mt-1">{openCount}</div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="text-xs text-red-600 font-medium">Crashes</div>
          <div className="text-2xl font-bold text-red-900 mt-1">{crashes}</div>
        </div>
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <div className="text-xs text-green-600 font-medium">Resolved</div>
          <div className="text-2xl font-bold text-green-900 mt-1">{feedback.length - openCount}</div>
        </div>
      </div>

      {/* Filter + List */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">
            User Feedback
            <span className="ml-2 text-xs text-slate-400">({feedback.length})</span>
          </h3>
          <div className="flex gap-1.5">
            {(["all", "open", "closed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                  filter === f
                    ? "bg-slate-900 text-white"
                    : "bg-slate-200 text-slate-500 hover:bg-slate-300"
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {feedback.length === 0 ? (
          <div className="px-4 py-8 text-center text-slate-400 text-sm">
            No feedback reports yet
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {feedback.map((f) => {
              const isExpanded = expandedId === f.id;
              const date = new Date(f.created_at);
              const source = f.source || (f.labels.includes("crash") ? "error-boundary" : "report-button");
              return (
                <div key={f.id} className="hover:bg-slate-50">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : f.id)}
                    className="w-full px-4 py-3 text-left"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${
                            SOURCE_COLORS[source] || SOURCE_COLORS.other
                          }`}>
                            {source.replace("-", " ")}
                          </span>
                          <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ${
                            f.state === "open" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                          }`}>
                            {f.state}
                          </span>
                          {f.wallet && (
                            <span className="text-[10px] font-mono text-slate-400">{f.wallet}</span>
                          )}
                        </div>
                        <p className="text-sm text-slate-900 truncate">
                          {f.message || f.title.replace("[User Report] ", "")}
                        </p>
                        {f.page && (
                          <p className="text-[11px] text-slate-400 mt-0.5 truncate">{f.page}</p>
                        )}
                      </div>
                      <div className="text-right whitespace-nowrap flex-shrink-0">
                        <span className="text-[10px] text-slate-400 block">{date.toLocaleDateString()}</span>
                        <span className="text-[10px] text-slate-400 block">{date.toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-3 space-y-2">
                      {f.errorMessage && (
                        <div className="p-2 bg-red-50 border border-red-200 rounded-lg">
                          <p className="text-xs text-red-700 font-mono whitespace-pre-wrap break-all">
                            {f.errorMessage}
                          </p>
                        </div>
                      )}
                      {f.body && (
                        <div className="text-xs text-slate-600 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto bg-slate-50 rounded-lg p-2 border border-slate-200">
                          {f.body.slice(0, 1500)}
                        </div>
                      )}
                      <div className="flex items-center gap-3">
                        <a
                          href={f.html_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          View on GitHub #{f.id}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
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

function getBadge(
  tab: AdminTab,
  data: {
    networkEvents: NetworkEvent[];
    recentSignals: SubgraphRecentSignal[];
    recentPurchases: SubgraphRecentPurchase[];
    attestations: AttestationEntry[];
    telemetryEvents: TelemetryEvent[];
    feedback: FeedbackEntry[];
  },
): string | null {
  switch (tab) {
    case "network": {
      const n = data.networkEvents.length;
      return n > 0 ? String(n) : null;
    }
    case "protocol": {
      const p = data.recentPurchases.length;
      const s = data.recentSignals.length;
      return p > 0 || s > 0 ? `${p} / ${s}` : null;
    }
    case "attestations": {
      const a = data.attestations.length;
      return a > 0 ? String(a) : null;
    }
    case "telemetry": {
      const t = data.telemetryEvents.length;
      return t > 0 ? String(t) : null;
    }
    case "feedback": {
      const open = data.feedback.filter((f) => f.state === "open").length;
      return open > 0 ? String(open) : null;
    }
    default:
      return null;
  }
}

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

function formatU16Pct(raw?: number): string {
  if (raw === undefined || raw === null) return "-";
  const pct = (raw / 65535) * 100;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  return `${pct.toFixed(4)}%`;
}


function formatEmission(raw?: string): string {
  if (!raw) return "-";
  const rao = BigInt(raw);
  if (rao === 0n) return "0";
  const perTempo = Number(rao) / 1e9;
  const perDay = perTempo * 20; // emission is per-tempo (360 blocks); 7200 blocks/day ÷ 360 = 20 tempos/day
  if (perDay >= 1) return `${perDay.toFixed(2)}α/d`;
  if (perDay >= 0.01) return `${perDay.toFixed(4)}α/d`;
  return `${perDay.toFixed(6)}α/d`;
}

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDetailValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") {
    if (v === 0) return "0";
    if (Math.abs(v) < 0.0001 && v !== 0) return v.toFixed(-Math.floor(Math.log10(Math.abs(v))) + 3);
    if (Math.abs(v) < 1) return v.toPrecision(3);
    return v.toLocaleString();
  }
  return String(v);
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
        return { ...data, uid: v.uid, ip: v.ip, port: v.port, hotkey: v.hotkey, coldkey: v.coldkey, ss58Hotkey: v.ss58Hotkey, stake: v.stake, alphaStake: v.alphaStake, taoStake: v.taoStake, validatorTrust: v.validatorTrust, incentive: v.incentive, emission: v.emission } as ValidatorHealth;
      }),
    );

    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { uid: validators[i].uid, ip: validators[i].ip, port: validators[i].port, hotkey: validators[i].hotkey, coldkey: validators[i].coldkey, ss58Hotkey: validators[i].ss58Hotkey, stake: validators[i].stake, alphaStake: validators[i].alphaStake, taoStake: validators[i].taoStake, validatorTrust: validators[i].validatorTrust, incentive: validators[i].incentive, emission: validators[i].emission, status: "error", version: "", shares_held: 0, chain_connected: false, bt_connected: false, attest_capable: false, error: String((r as PromiseRejectedResult).reason) },
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

async function fetchNetworkActivity(
  onStatus?: (status: Record<number, "pending" | "success" | "error">) => void,
  sinceTs?: number,
): Promise<NetworkActivityResult> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return { events: [], validatorsDiscovered: 0, validatorsResponded: 0, error: `Discovery failed (${discoverRes.status})` };
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };

    if (validators.length === 0) {
      return { events: [], validatorsDiscovered: 0, validatorsResponded: 0, error: "No validators found in metagraph" };
    }

    // Initialize all validators as pending
    const status: Record<number, "pending" | "success" | "error"> = {};
    for (const v of validators) status[v.uid] = "pending";
    onStatus?.({ ...status });

    // First load: last 24h. Subsequent: only new events since last fetch.
    const since = sinceTs || Math.floor(Date.now() / 1000) - 24 * 3600;
    const limit = sinceTs ? 200 : 1000;

    const results = await Promise.allSettled(
      validators.map(async (v) => {
        try {
          const res = await fetch(`/api/validators/${v.uid}/v1/telemetry?limit=${limit}&since=${since}`, {
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            status[v.uid] = "error";
            onStatus?.({ ...status });
            return [];
          }
          const data = await res.json();
          status[v.uid] = "success";
          onStatus?.({ ...status });
          return ((data.events || []) as NetworkEvent[]).map((e) => ({
            ...e,
            validatorUid: v.uid,
          }));
        } catch {
          status[v.uid] = "error";
          onStatus?.({ ...status });
          return [];
        }
      }),
    );

    const responded = Object.values(status).filter((s) => s === "success").length;
    const all: NetworkEvent[] = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<NetworkEvent[]>).value);
    all.sort((a, b) => b.timestamp - a.timestamp);
    return { events: all, validatorsDiscovered: validators.length, validatorsResponded: responded };
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

async function fetchAttestationData(sinceId?: number): Promise<AttestationEntry[]> {
  try {
    const discoverRes = await fetch("/api/validators/discover");
    if (!discoverRes.ok) return [];
    const { validators } = (await discoverRes.json()) as { validators: ValidatorNode[] };
    if (validators.length === 0) return [];

    // First load: last 200. Subsequent: only grab last 20 (new since last refresh).
    const limit = sinceId ? 20 : 200;

    const results = await Promise.allSettled(
      validators.map((v) =>
        fetch(`/api/validators/${v.uid}/v1/metrics/attestations?limit=${limit}`, {
          signal: AbortSignal.timeout(8000),
        }).then((r) => (r.ok ? r.json() : { attestations: [] }))
      )
    );
    const all: AttestationEntry[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        all.push(...(r.value.attestations || []));
      }
    }
    all.sort((a, b) => b.created_at - a.created_at);
    return all;
  } catch {
    return [];
  }
}

async function fetchFeedback(state: "all" | "open" | "closed"): Promise<FeedbackEntry[]> {
  try {
    const res = await fetch(`/api/admin/feedback?limit=50&state=${state}`, {
      signal: AbortSignal.timeout(10_000),
      credentials: "same-origin",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.feedback || [];
  } catch {
    return [];
  }
}

async function fetchMinerHealth(): Promise<MinerHealth[]> {
  try {
    const discoverRes = await fetch("/api/miners/discover");
    if (!discoverRes.ok) return [];
    const { miners } = (await discoverRes.json()) as { miners: MinerNode[] };

    // Probe health in batches of 20 to avoid overwhelming browser/serverless connections
    const BATCH_SIZE = 20;
    const all: MinerHealth[] = [];
    for (let i = 0; i < miners.length; i += BATCH_SIZE) {
      const batch = miners.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (m) => {
          const res = await fetch(`/api/miners/${m.uid}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const data = await res.json();
          return { ...data, uid: m.uid, ip: m.ip, port: m.port, hotkey: m.hotkey, coldkey: m.coldkey, ss58Hotkey: m.ss58Hotkey, stake: m.stake, alphaStake: m.alphaStake, taoStake: m.taoStake, incentive: m.incentive, emission: m.emission } as MinerHealth;
        }),
      );
      results.forEach((r, j) => {
        const m = batch[j];
        all.push(
          r.status === "fulfilled"
            ? r.value
            : { uid: m.uid, ip: m.ip, port: m.port, hotkey: m.hotkey, coldkey: m.coldkey, ss58Hotkey: m.ss58Hotkey, stake: m.stake, alphaStake: m.alphaStake, taoStake: m.taoStake, incentive: m.incentive, emission: m.emission, status: "error", version: "", odds_api_connected: false, bt_connected: false, uptime_seconds: 0, error: String((r as PromiseRejectedResult).reason) },
        );
      });
    }
    return all;
  } catch {
    return [];
  }
}

async function fetchTelemetry(sinceTs?: number): Promise<TelemetryEvent[]> {
  try {
    // Discover validators, then fetch /v1/telemetry from each
    const valRes = await fetch("/api/validators/discover");
    const validators: ValidatorNode[] = valRes.ok
      ? ((await valRes.json()) as { validators: ValidatorNode[] }).validators
      : [];

    // First load: last 24h, up to 1000 per validator. Subsequent: only new.
    const since = sinceTs || Math.floor(Date.now() / 1000) - 24 * 3600;
    const limit = sinceTs ? 200 : 1000;

    const results = await Promise.allSettled(
      validators.map(async (v) => {
        const res = await fetch(
          `/api/validators/${v.uid}/v1/telemetry?limit=${limit}&since=${since}`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!res.ok) return [];
        const data = await res.json();
        return ((data.events || []) as Array<{ id: number; timestamp: number; category: string; summary: string; details: Record<string, unknown> }>).map(
          (e) => ({
            ...e,
            sourceType: "validator" as const,
            sourceUid: v.uid,
          }),
        );
      }),
    );

    const all: TelemetryEvent[] = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<TelemetryEvent[]>).value);
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Telemetry Tab
// ---------------------------------------------------------------------------

const TELEMETRY_CATEGORY_COLORS: Record<string, string> = {
  startup: "bg-green-100 text-green-700",
  shutdown: "bg-red-100 text-red-700",
  challenge_round: "bg-blue-100 text-blue-700",
  challenge_received: "bg-blue-100 text-blue-700",
  challenge_error: "bg-red-100 text-red-700",
  attestation_challenge: "bg-cyan-100 text-cyan-700",
  attestation_success: "bg-emerald-100 text-emerald-700",
  attestation_failed: "bg-red-100 text-red-700",
  attestation_error: "bg-red-100 text-red-700",
  weight_set: "bg-amber-100 text-amber-700",
  weight_set_failed: "bg-red-100 text-red-700",
  outcome_resolution: "bg-purple-100 text-purple-700",
  audit_vote: "bg-indigo-100 text-indigo-700",
  audit_vote_error: "bg-red-100 text-red-700",
  epoch_error: "bg-red-100 text-red-700",
  health_ping: "bg-slate-100 text-slate-500",
  bt_deregistered: "bg-red-100 text-red-700",
};

function TelemetryTab({ events, loading }: { events: TelemetryEvent[]; loading: boolean }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | "validator" | "miner">("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (loading && events.length === 0) {
    return <div className="text-center text-slate-400 py-12">Loading telemetry...</div>;
  }

  let filtered = events;
  if (sourceFilter !== "all") {
    filtered = filtered.filter((e) => e.sourceType === sourceFilter);
  }
  if (filter) {
    filtered = filtered.filter((e) => e.category === filter);
  }

  const categories = [...new Set(events.map((e) => e.category))];
  const valCount = events.filter((e) => e.sourceType === "validator").length;
  const minCount = events.filter((e) => e.sourceType === "miner").length;
  const errorCount = filtered.filter((e) => e.category.includes("error") || e.category.includes("failed")).length;

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">
            Persistent Telemetry
            <span className="ml-2 text-xs text-slate-400">
              ({filtered.length}{filter || sourceFilter !== "all" ? ` of ${events.length}` : ""} events)
            </span>
          </h3>
          <div className="flex gap-1.5">
            {(["all", "validator", "miner"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSourceFilter(s)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  sourceFilter === s
                    ? "bg-slate-900 text-white"
                    : "bg-slate-200 text-slate-500 hover:bg-slate-300"
                }`}
              >
                {s === "all" ? "All" : s === "validator" ? `Validators (${valCount})` : `Miners (${minCount})`}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">
          SQLite-backed event history from all nodes. Survives restarts.
          {errorCount > 0 && <span className="text-red-400 ml-2">{errorCount} error{errorCount !== 1 ? "s" : ""}</span>}
        </p>
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
                    : TELEMETRY_CATEGORY_COLORS[cat] || "bg-slate-100 text-slate-600"
                }`}
              >
                {cat.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        )}
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-slate-400 text-sm">
          {events.length === 0
            ? "No telemetry data available. Nodes must be running the latest version with SQLite telemetry enabled."
            : "No events match the current filters."
          }
        </div>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[700px] overflow-y-auto">
          {filtered.map((event, i) => {
            const isExpanded = expandedIdx === i;
            const hasDetails = Object.keys(event.details || {}).length > 0;
            const isError = event.category.includes("error") || event.category.includes("failed");
            return (
              <div key={`${event.sourceType}-${event.sourceUid}-${event.id}`} className={`hover:bg-slate-50 ${isError ? "bg-red-50/30" : ""}`}>
                <button
                  onClick={() => hasDetails && setExpandedIdx(isExpanded ? null : i)}
                  className={`w-full px-4 py-2.5 text-left ${hasDetails ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {hasDetails && (
                        <span className={`text-slate-400 text-[10px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>
                          &#9654;
                        </span>
                      )}
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded whitespace-nowrap ${
                        event.sourceType === "validator" ? "bg-violet-100 text-violet-700" : "bg-orange-100 text-orange-700"
                      }`}>
                        {event.sourceType[0].toUpperCase()}{event.sourceUid}
                      </span>
                      <span
                        className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded whitespace-nowrap ${
                          TELEMETRY_CATEGORY_COLORS[event.category] || "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {event.category.replace(/_/g, " ")}
                      </span>
                      <span className="text-sm text-slate-700 truncate">{event.summary}</span>
                    </div>
                    <span className="text-[10px] text-slate-400 whitespace-nowrap">
                      {formatTimeAgo(event.timestamp)}
                    </span>
                  </div>
                </button>
                {isExpanded && (
                  <TelemetryDetailPanel event={event} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TelemetryDetailPanel({ event }: { event: TelemetryEvent }) {
  const d = event.details || {};
  const entries = Object.entries(d);
  if (entries.length === 0) return null;

  // Separate arrays from scalars for better layout
  const scalarEntries = entries.filter(([, v]) => !Array.isArray(v) && typeof v !== "object");
  const arrayEntries = entries.filter(([, v]) => Array.isArray(v));
  const objectEntries = entries.filter(([, v]) => typeof v === "object" && v !== null && !Array.isArray(v));

  const isError = event.category.includes("error") || event.category.includes("failed");
  const borderColor = isError ? "border-red-200" : "border-slate-200";
  const bgColor = isError ? "bg-red-50" : "bg-slate-50";

  return (
    <div className={`mx-4 mb-3 p-3 ${bgColor} border ${borderColor} rounded-lg text-xs`}>
      {scalarEntries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
          {scalarEntries.map(([k, v]) => (
            <div key={k}>
              <span className="text-slate-500 font-medium block">{k.replace(/_/g, " ")}</span>
              <span className={`font-mono ${isError && k === "error" ? "text-red-700" : "text-slate-800"}`}>
                {formatDetailValue(v)}
              </span>
            </div>
          ))}
          <div>
            <span className="text-slate-500 font-medium block">source</span>
            <span className="text-slate-800 font-mono">{event.sourceType} UID {event.sourceUid}</span>
          </div>
          <div>
            <span className="text-slate-500 font-medium block">time</span>
            <span className="text-slate-800">{new Date(event.timestamp * 1000).toLocaleString()}</span>
          </div>
        </div>
      )}
      {arrayEntries.map(([k, v]) => {
        const arr = v as unknown[];
        if (arr.length === 0) return null;
        // If it's an array of objects (like miners, challenge_lines), show as table
        if (typeof arr[0] === "object" && arr[0] !== null) {
          const items = arr as Array<Record<string, unknown>>;
          const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
          return (
            <div key={k} className="mt-2">
              <span className="text-slate-500 font-medium block mb-1">{k.replace(/_/g, " ")} ({arr.length})</span>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-slate-500">
                      {keys.map((col) => (
                        <th key={col} className="px-2 py-1 font-medium text-left">{col.replace(/_/g, " ")}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100/50">
                    {items.slice(0, 50).map((item, idx) => (
                      <tr key={idx}>
                        {keys.map((col) => (
                          <td key={col} className="px-2 py-1 font-mono text-slate-700">
                            {formatDetailValue(item[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {items.length > 50 && (
                  <div className="text-[10px] text-slate-400 mt-1">...and {items.length - 50} more</div>
                )}
              </div>
            </div>
          );
        }
        // Simple array of primitives
        return (
          <div key={k} className="mt-2">
            <span className="text-slate-500 font-medium block mb-1">{k.replace(/_/g, " ")}</span>
            <div className="flex flex-wrap gap-1">
              {arr.slice(0, 50).map((item, idx) => (
                <span key={idx} className="px-1.5 py-0.5 bg-slate-100 text-slate-700 font-mono text-[10px] rounded">
                  {formatDetailValue(item)}
                </span>
              ))}
              {arr.length > 50 && <span className="text-[10px] text-slate-400">...+{arr.length - 50}</span>}
            </div>
          </div>
        );
      })}
      {objectEntries.map(([k, v]) => (
        <div key={k} className="mt-2">
          <span className="text-slate-500 font-medium block mb-1">{k.replace(/_/g, " ")}</span>
          <pre className="text-[10px] text-slate-600 font-mono bg-white rounded p-2 overflow-x-auto">
            {JSON.stringify(v, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

async function fetchDelegateNames(): Promise<Record<string, string>> {
  try {
    const res = await fetch("/api/delegates", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Metagraph Discovery Tab
// ---------------------------------------------------------------------------

interface MetagraphNode {
  uid: number;
  hotkey: string;
  coldkey: string;
  ip: string;
  port: number;
  active?: boolean;
  stake: string;
  version: string | null;
}

interface MetagraphData {
  env: Record<string, string>;
  discoveryMs: number;
  minerDiscoveryMs: number;
  totalNodes: number;
  publicNodes: number;
  validators: number;
  miners: number;
  minerUrl: string | null;
  cacheAge: number | null;
  topMiners: MetagraphNode[];
  topValidators: MetagraphNode[];
  error?: string;
}

function MetagraphTab() {
  const [data, setData] = useState<MetagraphData | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, namesMap] = await Promise.all([
        fetch("/api/debug/metagraph", { signal: AbortSignal.timeout(30_000) }),
        fetchDelegateNames(),
      ]);
      setNames(namesMap);
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error || `HTTP ${res.status}`);
        setData(json.env ? json : null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const nodeName = (hotkey: string, coldkey?: string) => {
    return lookupName(names, hotkey, coldkey);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-slate-900">Metagraph Discovery</h2>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm font-medium text-red-800">Discovery Error</p>
          <p className="text-xs text-red-600 mt-1 font-mono">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Env vars */}
          <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Environment</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
              {Object.entries(data.env).map(([k, v]) => (
                <div key={k}>
                  <span className="text-slate-500 block">{k}</span>
                  <span className={`font-mono ${v === "(unset)" ? "text-red-500" : "text-slate-800"}`}>{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
            <div className="p-4 bg-white border border-slate-200 rounded-lg text-center">
              <p className="text-2xl font-bold text-slate-900">{data.totalNodes}</p>
              <p className="text-xs text-slate-500">Total Nodes</p>
            </div>
            <div className="p-4 bg-white border border-slate-200 rounded-lg text-center">
              <p className="text-2xl font-bold text-slate-900">{data.miners}</p>
              <p className="text-xs text-slate-500">Miners</p>
            </div>
            <div className="p-4 bg-white border border-slate-200 rounded-lg text-center">
              <p className="text-2xl font-bold text-slate-900">{data.validators}</p>
              <p className="text-xs text-slate-500">Validators</p>
            </div>
            <div className="p-4 bg-white border border-slate-200 rounded-lg text-center">
              <p className="text-2xl font-bold text-slate-900">{data.discoveryMs}ms</p>
              <p className="text-xs text-slate-500">Discovery Time</p>
            </div>
          </div>

          {/* Miner URL */}
          <div className="mb-6 p-4 bg-white border border-slate-200 rounded-lg">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Discovered Miner URL</h3>
            {data.minerUrl ? (
              <p className="text-sm font-mono text-emerald-700 bg-emerald-50 px-3 py-2 rounded">{data.minerUrl}</p>
            ) : (
              <p className="text-sm font-mono text-red-700 bg-red-50 px-3 py-2 rounded">None. Miner check will fail.</p>
            )}
            <p className="text-xs text-slate-400 mt-2">
              Miner discovery: {data.minerDiscoveryMs}ms
              {data.cacheAge !== null && ` · Cache age: ${Math.round(data.cacheAge / 1000)}s`}
            </p>
          </div>

          {/* Top validators */}
          {data.topValidators.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Top Validators (by stake)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500 border-b">
                      <th className="pb-2 pr-4">UID</th>
                      <th className="pb-2 pr-4">Name</th>
                      <th className="pb-2 pr-4">Endpoint</th>
                      <th className="pb-2 pr-4">Stake</th>
                      <th className="pb-2">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topValidators.map((v) => (
                      <tr key={v.uid} className="border-b border-slate-100">
                        <td className="py-2 pr-4 font-mono">{v.uid}</td>
                        <td className="py-2 pr-4">
                          {nodeName(v.hotkey, v.coldkey) ? (
                            <span className="font-semibold text-slate-700">{nodeName(v.hotkey, v.coldkey)}</span>
                          ) : (
                            <span className="font-mono text-slate-400" title={v.hotkey}>{v.hotkey?.slice(0, 8)}...</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-slate-600">
                          {v.active ? `${v.ip}:${v.port}` : <span className="text-slate-400 italic">stake only</span>}
                        </td>
                        <td className="py-2 pr-4 font-mono">{(Number(v.stake) / 1e9).toFixed(2)} α</td>
                        <td className="py-2 font-mono">
                          {v.version ? (
                            <span className={Number(v.version) >= 509 ? "text-green-600" : "text-amber-600"}>
                              {v.version}
                            </span>
                          ) : (
                            <span className="text-slate-400">{v.active ? "?" : "-"}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Top miners */}
          {data.topMiners.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Top 10 Miners</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500 border-b">
                      <th className="pb-2 pr-4">UID</th>
                      <th className="pb-2 pr-4">Name</th>
                      <th className="pb-2 pr-4">Endpoint</th>
                      <th className="pb-2 pr-4">Stake</th>
                      <th className="pb-2">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topMiners.map((m) => (
                      <tr key={m.uid} className="border-b border-slate-100">
                        <td className="py-2 pr-4 font-mono">{m.uid}</td>
                        <td className="py-2 pr-4">
                          {nodeName(m.hotkey, m.coldkey) ? (
                            <span className="font-semibold text-slate-700">{nodeName(m.hotkey, m.coldkey)}</span>
                          ) : (
                            <span className="font-mono text-slate-400" title={m.hotkey}>{m.hotkey?.slice(0, 8)}...</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-slate-600">{m.ip}:{m.port}</td>
                        <td className="py-2 pr-4 font-mono">{(Number(m.stake) / 1e9).toFixed(2)} α</td>
                        <td className="py-2 font-mono">
                          {m.version ? (
                            <span className={Number(m.version) >= 509 ? "text-green-600" : "text-amber-600"}>
                              {m.version}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
