"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import StatCard from "@/components/network/StatCard";
import MetricDropdown from "@/components/network/MetricDropdown";
import CopyTableButton, { useCopyTable } from "@/components/CopyTableButton";
import { formatStake, u16ToPercent, useSortable, type SortDir } from "@/components/network/helpers";

// Lazy-load chart (needs canvas/window)
const IncentiveChart = dynamic(() => import("@/components/network/IncentiveChart"), {
  ssr: false,
  loading: () => <div className="h-80 bg-slate-50 rounded-lg animate-pulse" />,
});

// ---------- Types ----------

interface ValidatorData {
  uid: number;
  ip: string;
  port: number;
  stake: string;
  ss58Hotkey?: string;
  coldkey?: string;
  validatorTrust: number;
  health: {
    status: string;
    version: string;
    shares_held?: number;
    chain_connected?: boolean;
    bt_connected?: boolean;
  } | null;
}

interface MinerData {
  uid: number;
  ip: string;
  incentive: number;
  emission: string;
  weight?: number;
  attestations_total?: number;
  attestations_valid?: number;
  lifetime_attestations?: number;
  lifetime_attestations_valid?: number;
  proactive_proof_verified?: boolean;
  uptime?: number;
  accuracy?: number;
}

interface Summary {
  totalValidators: number;
  totalMiners: number;
  validatorsHealthy: number;
  validatorsHoldingShares: number;
  totalShares: number;
  highestVersion: number;
  timestamp: number;
  uniqueIps: number;
  gini: number;
  burnPercent: number;
}

// ---------- Small components ----------

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
  return ok ? <span className="text-emerald-500">&#10003;</span> : <span className="text-red-400">&#10005;</span>;
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-slate-300 ml-0.5">&#8597;</span>;
  return <span className="text-slate-600 ml-0.5">{dir === "asc" ? "\u25B2" : "\u25BC"}</span>;
}

// ---------- Tables ----------

function lookupName(names: Record<string, string>, ss58Hotkey?: string, coldkey?: string): string | null {
  if (!ss58Hotkey && !coldkey) return null;
  // The delegate map uses hex keys; ss58Hotkey needs conversion.
  // But the map may also contain ss58 keys directly. Check both.
  for (const key of [ss58Hotkey, coldkey]) {
    if (key && names[key]) return names[key];
  }
  return null;
}

function ValidatorTable({ validators, names }: { validators: ValidatorData[]; names: Record<string, string> }) {
  const router = useRouter();
  const { ref: tableRef, copy, copied } = useCopyTable();
  const getVal = useCallback((v: ValidatorData, key: string): number | string => {
    switch (key) {
      case "uid": return v.uid;
      case "status": return v.health?.status === "ok" ? 1 : 0;
      case "version": return parseInt(v.health?.version || "0", 10);
      case "stake": return parseFloat(v.stake);
      case "vtrust": return v.validatorTrust;
      case "shares": return v.health?.shares_held ?? 0;
      default: return 0;
    }
  }, []);
  const { sorted, sortKey, sortDir, toggle } = useSortable(validators, "stake", "desc", getVal);
  if (!validators.length) return <p className="text-sm text-slate-400 py-4 px-3">No validators discovered.</p>;
  const Th = ({ k, children, align }: { k: string; children: React.ReactNode; align?: string }) => (
    <th className={`px-3 py-2 cursor-pointer select-none hover:text-slate-600 ${align || ""}`} onClick={() => toggle(k)}>
      {children}<SortArrow active={sortKey === k} dir={sortDir} />
    </th>
  );
  return (
    <div className="overflow-x-auto" ref={tableRef}>
      <div className="flex justify-end px-3 pt-2">
        <CopyTableButton onClick={copy} copied={copied} />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
            <Th k="uid">UID</Th>
            <th className="px-3 py-2">Name</th>
            <Th k="status">Status</Th>
            <Th k="version" align="text-right">Version</Th>
            <Th k="stake" align="text-right">Stake</Th>
            <Th k="vtrust" align="text-right">VTrust</Th>
            <Th k="shares" align="text-right">Shares</Th>
            <th className="px-3 py-2 text-center">Chain</th>
            <th className="px-3 py-2 text-center">BT</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
            <tr key={v.uid} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/network/validator/${v.uid}`)}>
              <td className="px-3 py-2 font-mono font-medium">
                <Link href={`/network/validator/${v.uid}`} className="text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>
                  {v.uid}
                </Link>
              </td>
              <td className="px-3 py-2 text-slate-700 text-xs truncate max-w-[140px]">{lookupName(names, v.ss58Hotkey, v.coldkey) || <span className="text-slate-300">-</span>}</td>
              <td className="px-3 py-2"><StatusBadge status={v.health?.status || "unreachable"} /></td>
              <td className="px-3 py-2 text-right font-mono text-slate-600">{v.health?.version || "-"}</td>
              <td className="px-3 py-2 text-right">{formatStake(v.stake)}</td>
              <td className="px-3 py-2 text-right">{u16ToPercent(v.validatorTrust)}</td>
              <td className="px-3 py-2 text-right font-mono">{v.health?.shares_held ?? "-"}</td>
              <td className="px-3 py-2 text-center"><Check ok={v.health?.chain_connected} /></td>
              <td className="px-3 py-2 text-center"><Check ok={v.health?.bt_connected} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttestBadge({ valid, total, proactive }: { valid: number; total: number; proactive?: boolean }) {
  if (total === 0 && !proactive) return <span className="text-slate-300">-</span>;
  const rate = total > 0 ? valid / total : 0;
  const color =
    proactive && valid === 0
      ? "text-amber-600" // proactive proof only, no challenge results yet
      : rate >= 0.8
        ? "text-emerald-600"
        : rate >= 0.5
          ? "text-amber-600"
          : total > 0
            ? "text-red-500"
            : "text-slate-400";
  return (
    <span className={`font-mono ${color}`}>
      {valid}/{total}
      {proactive && valid === 0 && <span className="text-[10px] ml-1" title="Proactive proof verified">P</span>}
    </span>
  );
}

function MinerTable({ miners }: { miners: MinerData[] }) {
  const router = useRouter();
  const { ref: tableRef, copy, copied } = useCopyTable();
  const getVal = useCallback((m: MinerData, key: string): number | string => {
    switch (key) {
      case "uid": return m.uid;
      case "ip": return m.ip;
      case "incentive": return m.incentive;
      case "emission": return parseFloat(m.emission);
      case "weight": return m.weight ?? 0;
      case "attest": {
        const t = m.lifetime_attestations ?? m.attestations_total ?? 0;
        const v = m.lifetime_attestations_valid ?? m.attestations_valid ?? 0;
        return t > 0 ? v / t : -1;
      }
      case "uptime": return m.uptime ?? 0;
      default: return 0;
    }
  }, []);
  const { sorted, sortKey, sortDir, toggle } = useSortable(miners, "incentive", "desc", getVal);
  if (!miners.length) return <p className="text-sm text-slate-400 py-4 px-3">No miners discovered.</p>;
  const hasScoring = miners.some((m) => m.weight !== undefined);
  const Th = ({ k, children, align }: { k: string; children: React.ReactNode; align?: string }) => (
    <th className={`px-3 py-2 cursor-pointer select-none hover:text-slate-600 ${align || ""}`} onClick={() => toggle(k)}>
      {children}<SortArrow active={sortKey === k} dir={sortDir} />
    </th>
  );
  return (
    <div className="overflow-x-auto" ref={tableRef}>
      <div className="flex justify-end px-3 pt-2">
        <CopyTableButton onClick={copy} copied={copied} />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 uppercase tracking-wide border-b">
            <Th k="uid">UID</Th>
            <Th k="ip">IP</Th>
            <Th k="incentive" align="text-right">Incentive</Th>
            <Th k="emission" align="text-right">Emission</Th>
            {hasScoring && <Th k="weight" align="text-right">Weight</Th>}
            {hasScoring && <Th k="uptime" align="text-right">Uptime</Th>}
            {hasScoring && <Th k="attest" align="text-right">Attest</Th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => {
            const aTotal = m.lifetime_attestations ?? m.attestations_total ?? 0;
            const aValid = m.lifetime_attestations_valid ?? m.attestations_valid ?? 0;
            return (
              <tr key={m.uid} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => router.push(`/network/miner/${m.uid}`)}>
                <td className="px-3 py-2 font-mono font-medium">
                  <Link href={`/network/miner/${m.uid}`} className="text-blue-600 hover:text-blue-800 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {m.uid}
                  </Link>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">{m.ip !== "0.0.0.0" ? m.ip : "-"}</td>
                <td className="px-3 py-2 text-right">{u16ToPercent(m.incentive)}</td>
                <td className="px-3 py-2 text-right font-mono">{formatStake(m.emission)}</td>
                {hasScoring && (
                  <td className="px-3 py-2 text-right font-mono">
                    {m.weight !== undefined ? m.weight.toFixed(4) : "-"}
                  </td>
                )}
                {hasScoring && (
                  <td className="px-3 py-2 text-right">
                    {m.uptime !== undefined ? `${(m.uptime * 100).toFixed(0)}%` : "-"}
                  </td>
                )}
                {hasScoring && (
                  <td className="px-3 py-2 text-right">
                    <AttestBadge valid={aValid} total={aTotal} proactive={m.proactive_proof_verified} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Main Page ----------

const METRIC_OPTIONS = [
  { value: "incentive", label: "Incentive" },
  { value: "emission", label: "Emission" },
];

export default function NetworkPage() {
  const [data, setData] = useState<{
    summary: Summary | null;
    validators: ValidatorData[];
    miners: MinerData[];
    ipClusters: Record<string, number[]>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");
  const [metric, setMetric] = useState<"incentive" | "emission">("incentive");
  const [showAll, setShowAll] = useState(false);

  const [delegateNames, setDelegateNames] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      fetch("/api/network/status").then((r) => r.json()),
      fetch("/api/delegates").then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ])
      .then(([json, names]) => {
        setData(json);
        setDelegateNames(names);
        if (json.summary?.timestamp) setLastUpdate(new Date(json.summary.timestamp).toLocaleTimeString());
      })
      .finally(() => setLoading(false));
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

  const s = data.summary;

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
          {lastUpdate && <span className="text-slate-400 ml-2">Updated {lastUpdate}</span>}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
        <StatCard label="Miners" value={String(s.totalMiners)} sub="registered" />
        <StatCard label="Unique IPs" value={String(s.uniqueIps)} sub={`${s.totalMiners - s.uniqueIps} shared`} />
        <StatCard label="Gini" value={s.gini.toFixed(3)} sub="incentive concentration" />
        <StatCard label="Burn" value={`${s.burnPercent}%`} sub="to UID 0" />
        <StatCard
          label="Validators"
          value={`${s.validatorsHealthy}/${s.totalValidators}`}
          sub="healthy"
        />
      </div>

      {/* Incentive curve chart */}
      <section className="mb-8">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Miner Rank</h2>
              <p className="text-sm text-slate-500">
                Sorted by {metric}, color-coded by IP cluster
              </p>
            </div>
            <div className="flex items-center gap-3">
              <MetricDropdown
                options={METRIC_OPTIONS}
                selected={metric}
                onChange={(v) => setMetric(v as "incentive" | "emission")}
              />
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
              >
                {showAll ? "Top 50" : `All ${s.totalMiners}`}
              </button>
            </div>
          </div>
          <IncentiveChart
            miners={data.miners}
            ipClusters={data.ipClusters}
            metric={metric}
            showAll={showAll}
          />
        </div>
      </section>

      {/* Miner table */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Miners <span className="text-sm font-normal text-slate-400">{s.totalMiners} registered</span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <MinerTable miners={data.miners} />
        </div>
      </section>

      {/* Validator table */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Validators <span className="text-sm font-normal text-slate-400">{s.validatorsHealthy}/{s.totalValidators} healthy</span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <ValidatorTable validators={data.validators} names={delegateNames} />
        </div>
      </section>

    </div>
  );
}
