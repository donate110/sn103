"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import StatCard from "@/components/network/StatCard";
import { formatStake, u16ToPercent, useSortable, type SortDir } from "@/components/network/helpers";

// ---------- Types ----------

interface MinerRow {
  uid: number;
  hotkey: string;
  status: string;
  weight: number;
  uptime: number;
  accuracy: number;
  queries_total: number;
  queries_correct: number;
  attestations_total: number;
  attestations_valid: number;
  lifetime_attestations: number;
  lifetime_attestations_valid: number;
  proactive_proof_verified: boolean;
  notary_duties_assigned: number;
  notary_duties_completed: number;
  notary_reliability: number;
}

interface Health {
  status: string;
  version: string;
  uid?: number;
  shares_held?: number;
  pending_outcomes?: number;
  chain_connected?: boolean;
  bt_connected?: boolean;
  attest_capable?: boolean;
}

interface Metagraph {
  ip: string;
  port: number;
  stake: string;
  incentive: number;
  emission: string;
  validatorTrust: number;
}

// ---------- Small components ----------

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-slate-300 ml-0.5">&#8597;</span>;
  return <span className="text-slate-600 ml-0.5">{dir === "asc" ? "\u25B2" : "\u25BC"}</span>;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-slate-300"}`} />
  );
}

function AttestCell({ valid, total, proactive }: { valid: number; total: number; proactive: boolean }) {
  if (total === 0 && !proactive) return <span className="text-slate-300">-</span>;
  const rate = total > 0 ? valid / total : 0;
  const color =
    proactive && total === 0
      ? "text-amber-600"
      : rate >= 0.8
        ? "text-emerald-600"
        : rate >= 0.5
          ? "text-amber-600"
          : total > 0
            ? "text-red-500"
            : "text-slate-400";
  return (
    <div>
      <span className={`font-mono ${color}`}>{valid}/{total}</span>
      {proactive && total === 0 && (
        <span className="text-[10px] text-amber-500 ml-1" title="Proactive proof verified">P</span>
      )}
      {total > 0 && (
        <span className="text-[10px] text-slate-400 ml-1">
          ({(rate * 100).toFixed(0)}%)
        </span>
      )}
    </div>
  );
}

// ---------- Miner Table ----------

function MinerScoringTable({ miners }: { miners: MinerRow[] }) {
  const getVal = useCallback((m: MinerRow, key: string): number | string => {
    switch (key) {
      case "uid": return m.uid;
      case "status": return m.status === "ok" ? 1 : 0;
      case "weight": return m.weight;
      case "uptime": return m.uptime;
      case "accuracy": return m.accuracy;
      case "attest": {
        const t = m.lifetime_attestations || m.attestations_total;
        const v = m.lifetime_attestations_valid || m.attestations_valid;
        return t > 0 ? v / t : -1;
      }
      case "notary": return m.notary_reliability;
      case "queries": return m.queries_correct;
      default: return 0;
    }
  }, []);

  const { sorted, sortKey, sortDir, toggle } = useSortable(miners, "weight", "desc", getVal);

  if (!miners.length) {
    return <p className="text-sm text-slate-400 py-4 px-3">No miners tracked by this validator.</p>;
  }

  const Th = ({ k, children, align }: { k: string; children: React.ReactNode; align?: string }) => (
    <th className={`px-3 py-2 cursor-pointer select-none hover:text-slate-600 ${align || ""}`} onClick={() => toggle(k)}>
      {children}<SortArrow active={sortKey === k} dir={sortDir} />
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
            <Th k="uid">UID</Th>
            <Th k="status">Status</Th>
            <Th k="weight" align="text-right">Weight</Th>
            <Th k="uptime" align="text-right">Uptime</Th>
            <Th k="accuracy" align="text-right">Accuracy</Th>
            <Th k="queries" align="text-right">Queries</Th>
            <Th k="attest" align="text-right">Attest</Th>
            <Th k="notary" align="text-right">Notary</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const aTotal = m.lifetime_attestations || m.attestations_total;
            const aValid = m.lifetime_attestations_valid || m.attestations_valid;
            return (
              <tr key={m.uid} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => window.location.href = `/network/miner/${m.uid}`}>
                <td className="px-3 py-2 font-mono font-medium">
                  <Link href={`/network/miner/${m.uid}`} className="text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {m.uid}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusDot ok={m.status === "ok"} />
                </td>
                <td className="px-3 py-2 text-right font-mono">{m.weight.toFixed(4)}</td>
                <td className="px-3 py-2 text-right">{(m.uptime * 100).toFixed(0)}%</td>
                <td className="px-3 py-2 text-right">{(m.accuracy * 100).toFixed(0)}%</td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {m.queries_correct}/{m.queries_total}
                </td>
                <td className="px-3 py-2 text-right">
                  <AttestCell valid={aValid} total={aTotal} proactive={m.proactive_proof_verified} />
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {m.notary_duties_assigned > 0
                    ? `${m.notary_duties_completed}/${m.notary_duties_assigned}`
                    : <span className="text-slate-300">-</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Main Page ----------

export default function ValidatorPage() {
  const params = useParams();
  const uid = params.uid as string;
  const [metagraph, setMetagraph] = useState<Metagraph | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [miners, setMiners] = useState<MinerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/network/validator/${uid}`);
      const data = await res.json();
      if (!data.found) {
        setError(data.error || "Validator not found.");
        return;
      }
      setMetagraph(data.metagraph);
      setHealth(data.health);
      setMiners(data.miners || []);
      setError("");
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      setError("Failed to load validator data.");
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    load();
  }, [load]);

  const onlineMiners = miners.filter((m) => m.status === "ok").length;
  const totalWeight = miners.reduce((s, m) => s + (m.weight || 0), 0);
  const attestingMiners = miners.filter(
    (m) => (m.lifetime_attestations || m.attestations_total) > 0,
  ).length;
  const totalAttempts = miners.reduce(
    (s, m) => s + (m.lifetime_attestations || m.attestations_total || 0),
    0,
  );
  const totalValid = miners.reduce(
    (s, m) => s + (m.lifetime_attestations_valid || m.attestations_valid || 0),
    0,
  );

  return (
    <div className="max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6">
        <Link href="/network" className="text-slate-400 hover:text-slate-600 text-sm">
          Network
        </Link>
        <span className="text-slate-300">/</span>
        <span className="text-sm text-slate-600">Validator {uid}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Image src="/djinn-logo.png" alt="Djinn" width={32} height={32} />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Validator UID {uid}</h1>
            <p className="text-sm text-slate-400">
              {metagraph && `${metagraph.ip}:${metagraph.port}`}
              {health?.version && ` | v${health.version}`}
              {metagraph && ` | Stake: ${formatStake(metagraph.stake)}`}
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

      {!loading && health && (
        <>
          {/* Health cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
            <StatCard
              label="Status"
              value={health.status === "ok" ? "Healthy" : "Down"}
              sub={health.version ? `v${health.version}` : "unknown version"}
            />
            <StatCard
              label="Shares"
              value={String(health.shares_held ?? 0)}
              sub="MPC key shares held"
            />
            <StatCard
              label="Miners"
              value={`${onlineMiners}/${miners.length}`}
              sub="online / tracked"
            />
            <StatCard
              label="Attestations"
              value={totalAttempts > 0 ? `${((totalValid / totalAttempts) * 100).toFixed(0)}%` : "-"}
              sub={`${totalValid}/${totalAttempts} across ${attestingMiners} miners`}
            />
            <StatCard
              label="Connectivity"
              value={
                health.chain_connected && health.bt_connected
                  ? "Full"
                  : health.chain_connected || health.bt_connected
                    ? "Partial"
                    : "None"
              }
              sub={`Chain: ${health.chain_connected ? "yes" : "no"} | BT: ${health.bt_connected ? "yes" : "no"}`}
            />
          </div>

          {/* Quick info row */}
          <div className="card mb-8">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-[11px] text-slate-400 uppercase">VTrust</p>
                <p className="font-mono font-semibold">
                  {metagraph ? u16ToPercent(metagraph.validatorTrust) : "-"}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 uppercase">Pending Outcomes</p>
                <p className="font-mono font-semibold">{health.pending_outcomes ?? 0}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 uppercase">Attest Capable</p>
                <p className="font-semibold">{health.attest_capable ? "Yes" : "No"}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-400 uppercase">Total Weight Sum</p>
                <p className="font-mono font-semibold">{totalWeight.toFixed(4)}</p>
              </div>
            </div>
          </div>

          {/* Miner scoring table */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-slate-900 mb-3">
              Miner Scoring{" "}
              <span className="text-sm font-normal text-slate-400">
                {miners.length} miners tracked
              </span>
            </h2>
            <div className="card p-0 overflow-hidden">
              <MinerScoringTable miners={miners} />
            </div>
          </section>
        </>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-slate-300 border-t-slate-600 rounded-full mx-auto mb-4" />
          <p className="text-slate-500">Loading validator data...</p>
        </div>
      )}
    </div>
  );
}
