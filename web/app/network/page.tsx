"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";

// ---------- Types ----------

interface HealthResult {
  uid: number;
  status: string;
  version: string;
  shares_held?: number;
  odds_api_connected?: boolean;
  bt_connected?: boolean;
  chain_connected?: boolean;
  attest_capable?: boolean;
  uptime_seconds?: number;
  error?: string;
}

interface NodeWithHealth {
  uid: number;
  ip: string;
  port: number;
  hotkey: string;
  ss58Hotkey: string;
  stake: string;
  incentive: number;
  emission: string;
  isValidator: boolean;
  trust: number;
  validatorTrust: number;
  dividends: number;
  consensus: number;
  health: HealthResult | null;
}

interface Summary {
  totalValidators: number;
  totalMiners: number;
  validatorsRunningDjinn: number;
  validatorsHealthy: number;
  validatorsHoldingShares: number;
  totalShares: number;
  minersRunningDjinn: number;
  minersHealthy: number;
  minersOddsConnected: number;
  minersBtConnected: number;
  attestCapableMiners: number;
  attestCapableValidators: number;
  highestVersion: number;
  timestamp: number;
}

interface NetworkData {
  summary: Summary | null;
  validators: NodeWithHealth[];
  miners: NodeWithHealth[];
}

interface MinerScores {
  validatorUid: number;
  weight: number;
  challenges?: { total: number; passed: number; failed: number };
  accuracy?: number;
  responseTime?: number;
  error?: string;
}

// ---------- Helpers ----------

function formatStake(raw: string): string {
  const tao = parseFloat(raw) / 1e9;
  if (tao >= 1000) return `${(tao / 1000).toFixed(1)}k`;
  if (tao >= 1) return tao.toFixed(1);
  return tao.toFixed(4);
}

function formatUptime(seconds?: number): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "ok"
      ? "bg-emerald-100 text-emerald-700"
      : status === "unreachable"
        ? "bg-slate-100 text-slate-500"
        : "bg-red-100 text-red-700";
  return (
    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${color}`}>
      {status === "ok" ? "Healthy" : status === "unreachable" ? "Offline" : "Error"}
    </span>
  );
}

function Check({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return <span className="text-slate-300">-</span>;
  return ok ? (
    <span className="text-emerald-500">&#10003;</span>
  ) : (
    <span className="text-red-400">&#10005;</span>
  );
}

// ---------- Components ----------

function SummaryCards({ summary }: { summary: Summary }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      <div className="card text-center">
        <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Validators</p>
        <p className="text-2xl font-bold text-slate-900">
          {summary.validatorsHealthy}
          <span className="text-sm font-normal text-slate-400">/{summary.totalValidators}</span>
        </p>
        <p className="text-[11px] text-slate-400">healthy</p>
      </div>
      <div className="card text-center">
        <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Miners</p>
        <p className="text-2xl font-bold text-slate-900">
          {summary.minersHealthy}
          <span className="text-sm font-normal text-slate-400">/{summary.totalMiners}</span>
        </p>
        <p className="text-[11px] text-slate-400">healthy</p>
      </div>
      <div className="card text-center">
        <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Key Shares</p>
        <p className="text-2xl font-bold text-slate-900">{summary.totalShares.toLocaleString()}</p>
        <p className="text-[11px] text-slate-400">across {summary.validatorsHoldingShares} validators</p>
      </div>
      <div className="card text-center">
        <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Latest Version</p>
        <p className="text-2xl font-bold text-slate-900">v{summary.highestVersion}</p>
        <p className="text-[11px] text-slate-400">
          {summary.attestCapableMiners + summary.attestCapableValidators} attest-capable
        </p>
      </div>
    </div>
  );
}

function ValidatorTable({ validators }: { validators: NodeWithHealth[] }) {
  if (validators.length === 0)
    return <p className="text-sm text-slate-400 py-4">No validators discovered.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
            <th className="px-3 py-2">UID</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Version</th>
            <th className="px-3 py-2 text-right">Stake</th>
            <th className="px-3 py-2 text-right">VTrust</th>
            <th className="px-3 py-2 text-right">Shares</th>
            <th className="px-3 py-2 text-center">Chain</th>
            <th className="px-3 py-2 text-center">BT</th>
          </tr>
        </thead>
        <tbody>
          {validators.map((v) => (
            <tr key={v.uid} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-mono font-medium">{v.uid}</td>
              <td className="px-3 py-2">
                <StatusBadge status={v.health?.status || "unreachable"} />
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-600">
                {v.health?.version || "-"}
              </td>
              <td className="px-3 py-2 text-right">{formatStake(v.stake)}</td>
              <td className="px-3 py-2 text-right">
                {(v.validatorTrust * 100).toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {v.health?.shares_held ?? "-"}
              </td>
              <td className="px-3 py-2 text-center">
                <Check ok={v.health?.chain_connected} />
              </td>
              <td className="px-3 py-2 text-center">
                <Check ok={v.health?.bt_connected} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinerTable({ miners }: { miners: NodeWithHealth[] }) {
  if (miners.length === 0)
    return <p className="text-sm text-slate-400 py-4">No miners discovered.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
            <th className="px-3 py-2">UID</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Version</th>
            <th className="px-3 py-2 text-right">Incentive</th>
            <th className="px-3 py-2 text-right">Emission</th>
            <th className="px-3 py-2 text-center">Odds</th>
            <th className="px-3 py-2 text-center">BT</th>
            <th className="px-3 py-2 text-right">Uptime</th>
          </tr>
        </thead>
        <tbody>
          {miners.map((m) => (
            <tr key={m.uid} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-mono font-medium">{m.uid}</td>
              <td className="px-3 py-2">
                <StatusBadge status={m.health?.status || "unreachable"} />
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-600">
                {m.health?.version || "-"}
              </td>
              <td className="px-3 py-2 text-right">
                {(m.incentive * 100).toFixed(2)}%
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {formatStake(m.emission)}
              </td>
              <td className="px-3 py-2 text-center">
                <Check ok={m.health?.odds_api_connected} />
              </td>
              <td className="px-3 py-2 text-center">
                <Check ok={m.health?.bt_connected} />
              </td>
              <td className="px-3 py-2 text-right text-slate-500">
                {formatUptime(m.health?.uptime_seconds)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinerLookup() {
  const [uid, setUid] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<MinerScores[]>([]);
  const [error, setError] = useState("");

  const lookup = useCallback(async () => {
    if (!uid.trim()) return;
    setLoading(true);
    setError("");
    setResults([]);

    try {
      // First get validators
      const discRes = await fetch("/api/validators/discover");
      const { validators } = await discRes.json();
      if (!validators || validators.length === 0) {
        setError("No validators available for scoring lookup.");
        setLoading(false);
        return;
      }

      // Query each validator for this miner's scores
      const promises = validators.slice(0, 10).map(async (v: { uid: number }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(
            `/api/validators/${v.uid}/v1/miner/${uid.trim()}/scores`,
            { signal: controller.signal },
          );
          clearTimeout(timeout);
          if (!res.ok) return { validatorUid: v.uid, weight: 0, error: `HTTP ${res.status}` };
          const data = await res.json();
          return { validatorUid: v.uid, ...data };
        } catch {
          return { validatorUid: v.uid, weight: 0, error: "timeout" };
        }
      });

      const all = await Promise.all(promises);
      setResults(all.filter((r) => !r.error));
      if (all.every((r) => r.error)) {
        setError("No validators returned scoring data for this UID. The miner may not be registered or validators may be unreachable.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }, [uid]);

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Miner Lookup</h2>
      <p className="text-sm text-slate-500 mb-4">
        Enter a miner UID to see how validators are scoring it.
      </p>
      <div className="flex gap-2 mb-4">
        <input
          type="number"
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookup()}
          placeholder="Enter miner UID"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          onClick={lookup}
          disabled={loading || !uid.trim()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Querying..." : "Lookup"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
                <th className="px-3 py-2">Validator</th>
                <th className="px-3 py-2 text-right">Weight</th>
                <th className="px-3 py-2 text-right">Challenges</th>
                <th className="px-3 py-2 text-right">Accuracy</th>
                <th className="px-3 py-2 text-right">Response Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.validatorUid} className="border-b border-slate-100">
                  <td className="px-3 py-2 font-mono">UID {r.validatorUid}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {typeof r.weight === "number" ? r.weight.toFixed(6) : "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.challenges
                      ? `${r.challenges.passed}/${r.challenges.total}`
                      : "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.accuracy !== undefined ? `${(r.accuracy * 100).toFixed(1)}%` : "-"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.responseTime !== undefined ? `${r.responseTime.toFixed(0)}ms` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Main Page ----------

export default function NetworkPage() {
  const [data, setData] = useState<NetworkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<string>("");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/network/status");
        const json = await res.json();
        setData(json);
        if (json.summary?.timestamp) {
          setLastUpdate(new Date(json.summary.timestamp).toLocaleTimeString());
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 120_000); // refresh every 2 min
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-12 text-center">
        <div className="animate-spin w-8 h-8 border-2 border-slate-300 border-t-slate-600 rounded-full mx-auto mb-4" />
        <p className="text-slate-500">Loading network status...</p>
      </div>
    );
  }

  if (!data?.summary) {
    return (
      <div className="max-w-6xl mx-auto py-12 text-center">
        <p className="text-slate-500">Network data unavailable. Try again shortly.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Image src="/djinn-logo.png" alt="Djinn" width={36} height={36} />
          <h1 className="text-2xl font-bold text-slate-900">Network Status</h1>
        </div>
        <p className="text-slate-500">
          Live infrastructure status for Bittensor Subnet 103.
          {lastUpdate && (
            <span className="text-slate-400 ml-2">Updated {lastUpdate}</span>
          )}
        </p>
      </div>

      {/* Summary Cards */}
      <SummaryCards summary={data.summary} />

      {/* Validators */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Validators
          <span className="text-sm font-normal text-slate-400 ml-2">
            {data.summary.validatorsHealthy}/{data.summary.totalValidators} healthy
          </span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <ValidatorTable validators={data.validators} />
        </div>
      </section>

      {/* Miners */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Miners
          <span className="text-sm font-normal text-slate-400 ml-2">
            {data.summary.minersHealthy}/{data.summary.totalMiners} healthy
          </span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <MinerTable miners={data.miners} />
        </div>
      </section>

      {/* Miner Lookup */}
      <section className="mb-8">
        <MinerLookup />
      </section>
    </div>
  );
}
