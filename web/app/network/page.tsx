"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";

// ---------- Types ----------

interface ValidatorData {
  uid: number;
  stake: string;
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
  incentive: number;
  emission: string;
}

interface Summary {
  totalValidators: number;
  totalMiners: number;
  validatorsHealthy: number;
  validatorsHoldingShares: number;
  totalShares: number;
  highestVersion: number;
  timestamp: number;
}

type SortDir = "asc" | "desc";

// ---------- Helpers ----------

function formatStake(raw: string): string {
  const tao = parseFloat(raw) / 1e9;
  if (tao >= 1000) return `${(tao / 1000).toFixed(1)}k`;
  if (tao >= 1) return tao.toFixed(1);
  return tao.toFixed(4);
}

function u16ToPercent(val: number): string {
  return ((val / 65535) * 100).toFixed(1) + "%";
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

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-slate-300 ml-0.5">&#8597;</span>;
  return <span className="text-slate-600 ml-0.5">{dir === "asc" ? "\u25B2" : "\u25BC"}</span>;
}

function useSortable<T>(
  items: T[],
  defaultKey: string,
  defaultDir: SortDir,
  getVal: (item: T, key: string) => number | string,
) {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);
  const toggle = useCallback(
    (key: string) => {
      if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      else { setSortKey(key); setSortDir("desc"); }
    },
    [sortKey],
  );
  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const va = getVal(a, sortKey);
      const vb = getVal(b, sortKey);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [items, sortKey, sortDir, getVal]);
  return { sorted, sortKey, sortDir, toggle };
}

// ---------- Components ----------

function ValidatorTable({ validators }: { validators: ValidatorData[] }) {
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
  if (!validators.length) return <p className="text-sm text-slate-400 py-4">No validators discovered.</p>;
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
            <tr key={v.uid} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-mono font-medium">{v.uid}</td>
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

function MinerTable({ miners }: { miners: MinerData[] }) {
  const getVal = useCallback((m: MinerData, key: string): number | string => {
    switch (key) {
      case "uid": return m.uid;
      case "incentive": return m.incentive;
      case "emission": return parseFloat(m.emission);
      default: return 0;
    }
  }, []);
  const { sorted, sortKey, sortDir, toggle } = useSortable(miners, "incentive", "desc", getVal);
  if (!miners.length) return <p className="text-sm text-slate-400 py-4">No miners discovered.</p>;
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
            <Th k="incentive" align="text-right">Incentive</Th>
            <Th k="emission" align="text-right">Emission</Th>
            <th className="px-3 py-2 text-right">Details</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((m) => (
            <tr key={m.uid} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-mono font-medium">
                <Link href={`/network/miner/${m.uid}`} className="text-blue-600 hover:text-blue-800 hover:underline">
                  {m.uid}
                </Link>
              </td>
              <td className="px-3 py-2 text-right">{u16ToPercent(m.incentive)}</td>
              <td className="px-3 py-2 text-right font-mono">{formatStake(m.emission)}</td>
              <td className="px-3 py-2 text-right">
                <Link href={`/network/miner/${m.uid}`} className="text-xs text-blue-600 hover:underline">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MinerSearch() {
  const [uid, setUid] = useState("");
  const go = () => { if (uid.trim()) window.location.href = `/network/miner/${uid.trim()}`; };
  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Miner Lookup</h2>
      <p className="text-sm text-slate-500 mb-4">
        Enter a miner UID or click any UID in the table above.
      </p>
      <div className="flex gap-2">
        <input
          type="number" value={uid} onChange={(e) => setUid(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="Enter miner UID"
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
        />
        <button onClick={go} disabled={!uid.trim()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          View Miner
        </button>
      </div>
    </div>
  );
}

// ---------- Main Page ----------

export default function NetworkPage() {
  const [data, setData] = useState<{ summary: Summary | null; validators: ValidatorData[]; miners: MinerData[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState("");

  useEffect(() => {
    fetch("/api/network/status")
      .then((r) => r.json())
      .then((json) => {
        setData(json);
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <div className="card text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Validators</p>
          <p className="text-2xl font-bold">{s.validatorsHealthy}<span className="text-sm font-normal text-slate-400">/{s.totalValidators}</span></p>
          <p className="text-[11px] text-slate-400">healthy</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Miners</p>
          <p className="text-2xl font-bold">{s.totalMiners}</p>
          <p className="text-[11px] text-slate-400">registered</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Key Shares</p>
          <p className="text-2xl font-bold">{s.totalShares.toLocaleString()}</p>
          <p className="text-[11px] text-slate-400">across {s.validatorsHoldingShares} validators</p>
        </div>
        <div className="card text-center">
          <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">Latest Version</p>
          <p className="text-2xl font-bold">v{s.highestVersion}</p>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Validators <span className="text-sm font-normal text-slate-400">{s.validatorsHealthy}/{s.totalValidators} healthy</span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <ValidatorTable validators={data.validators} />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">
          Miners <span className="text-sm font-normal text-slate-400">{s.totalMiners} registered</span>
        </h2>
        <div className="card p-0 overflow-hidden">
          <MinerTable miners={data.miners} />
        </div>
      </section>

      <section className="mb-8">
        <MinerSearch />
      </section>
    </div>
  );
}
