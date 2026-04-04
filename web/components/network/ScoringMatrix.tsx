"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

// ---------- Types ----------

interface MinerEntry {
  uid: number;
  status: string;
  weight: number;
  accuracy: number;
  uptime: number;
  queries_total: number;
  queries_correct: number;
  attestations_total: number;
  attestations_valid: number;
  proactive_proof_verified: boolean;
  notary_duties_assigned: number;
  notary_duties_completed: number;
  notary_reliability: number;
}

interface ValidatorData {
  uid: number;
  version: string | null;
  healthy: boolean;
  stake: string;
  miners: Record<number, MinerEntry>;
}

interface MatrixData {
  validators: ValidatorData[];
  minerUids: number[];
  timestamp: number;
}

type SortMode = "uid" | "avg-weight" | "worst" | "alerts";

// ---------- Helpers ----------

/** Compute median of an array of numbers */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Weight-to-color: green above median, red below, relative to validator */
function weightColor(weight: number, med: number, max: number): string {
  if (max === 0) return "bg-slate-100";
  const ratio = med > 0 ? weight / med : weight / (max || 1);

  if (ratio >= 1.5) return "bg-emerald-200";
  if (ratio >= 1.0) return "bg-emerald-100";
  if (ratio >= 0.5) return "bg-amber-50";
  if (ratio > 0) return "bg-red-100";
  return "bg-red-200";
}

/** Determine if a cell has an alert condition */
function cellAlerts(m: MinerEntry): string[] {
  const alerts: string[] = [];
  if (m.attestations_total >= 5 && m.attestations_valid === 0) {
    alerts.push("0% attestation validity");
  }
  if (m.queries_total >= 10 && m.queries_correct === 0) {
    alerts.push("0% sports accuracy");
  }
  if (m.uptime === 0 && (m.queries_total > 0 || m.attestations_total > 0)) {
    alerts.push("0% uptime");
  }
  if (m.notary_duties_assigned >= 3 && m.notary_duties_completed === 0) {
    alerts.push("0% notary completion");
  }
  return alerts;
}

/** Status indicator: check, X, or dash */
function Indicator({
  ok,
  total,
  label,
}: {
  ok: boolean;
  total: number;
  label: string;
}) {
  if (total === 0)
    return (
      <span className="text-slate-300 text-[10px]" title={`${label}: no data`}>
        -
      </span>
    );
  return ok ? (
    <span className="text-emerald-600 text-[10px]" title={`${label}: passing`}>
      &#10003;
    </span>
  ) : (
    <span className="text-red-500 text-[10px]" title={`${label}: failing`}>
      &#10005;
    </span>
  );
}

// ---------- Cell ----------

function MatrixCell({
  miner,
  medianWeight,
  maxWeight,
}: {
  miner: MinerEntry | undefined;
  medianWeight: number;
  maxWeight: number;
}) {
  if (!miner) {
    return (
      <td className="border border-slate-200 bg-slate-50 w-12 h-10" title="Not tracked">
        <div className="flex items-center justify-center text-slate-300 text-[10px]">
          -
        </div>
      </td>
    );
  }

  const alerts = cellAlerts(miner);
  const bg = weightColor(miner.weight, medianWeight, maxWeight);
  const hasAlert = alerts.length > 0;

  // Sports: passing if accuracy > 0 or not enough data to judge
  const sportsOk =
    miner.queries_total < 5 || miner.queries_correct / miner.queries_total >= 0.3;
  // Attestation: passing if validity > 0 or not enough data
  const attestOk =
    miner.attestations_total < 3 ||
    miner.attestations_valid / miner.attestations_total >= 0.3 ||
    (miner.proactive_proof_verified && miner.attestations_total === 0);
  // Notary: passing if reliability > 0 or not enough assignments
  const notaryOk =
    miner.notary_duties_assigned < 2 ||
    miner.notary_duties_completed / miner.notary_duties_assigned >= 0.3;

  return (
    <td
      className={`border border-slate-200 w-12 h-10 relative ${bg} ${
        hasAlert ? "ring-2 ring-inset ring-red-400" : ""
      }`}
      title={
        hasAlert
          ? alerts.join(", ")
          : `W: ${(miner.weight * 100).toFixed(1)}% | S: ${miner.queries_correct}/${miner.queries_total} | A: ${miner.attestations_valid}/${miner.attestations_total} | N: ${miner.notary_duties_completed}/${miner.notary_duties_assigned}`
      }
    >
      <div className="flex items-center justify-center gap-[2px]">
        <Indicator ok={sportsOk} total={miner.queries_total} label="Sports" />
        <Indicator ok={attestOk} total={miner.attestations_total} label="Attest" />
        <Indicator ok={notaryOk} total={miner.notary_duties_assigned} label="Notary" />
      </div>
      {hasAlert && (
        <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full flex items-center justify-center">
          <span className="text-white text-[7px] font-bold">!</span>
        </div>
      )}
    </td>
  );
}

// ---------- Legend ----------

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500 mb-3">
      <span className="font-medium text-slate-700">Cell color = weight (relative to validator median):</span>
      <span className="inline-flex items-center gap-1">
        <span className="w-4 h-3 rounded bg-emerald-200 inline-block" /> High
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-4 h-3 rounded bg-emerald-100 inline-block" /> Above avg
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-4 h-3 rounded bg-amber-50 inline-block border border-amber-200" /> Below avg
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-4 h-3 rounded bg-red-100 inline-block" /> Low
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-4 h-3 rounded bg-red-200 inline-block" /> Zero
      </span>
      <span className="ml-2 font-medium text-slate-700">Indicators:</span>
      <span>
        <span className="text-emerald-600">&#10003;</span>/<span className="text-red-500">&#10005;</span>/<span className="text-slate-300">-</span>{" "}
        = S(ports) A(ttest) N(otary)
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="w-3 h-3 rounded-full bg-red-500 inline-flex items-center justify-center">
          <span className="text-white text-[7px] font-bold">!</span>
        </span>{" "}
        Alert
      </span>
    </div>
  );
}

// ---------- Main ----------

export default function ScoringMatrix() {
  const [data, setData] = useState<MatrixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("avg-weight");
  const [filterAlerts, setFilterAlerts] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/network/matrix")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Precompute per-validator medians and maxes
  const valStats = useMemo(() => {
    if (!data) return new Map<number, { median: number; max: number }>();
    const m = new Map<number, { median: number; max: number }>();
    for (const v of data.validators) {
      const weights = Object.values(v.miners).map((mi) => mi.weight);
      m.set(v.uid, {
        median: median(weights),
        max: weights.length ? Math.max(...weights) : 0,
      });
    }
    return m;
  }, [data]);

  // Compute per-miner averages and alert counts for sorting
  const minerMeta = useMemo(() => {
    if (!data) return new Map<number, { avgWeight: number; worstWeight: number; alertCount: number }>();
    const m = new Map<number, { avgWeight: number; worstWeight: number; alertCount: number }>();
    for (const uid of data.minerUids) {
      let weightSum = 0;
      let weightCount = 0;
      let worst = Infinity;
      let alerts = 0;
      for (const v of data.validators) {
        const miner = v.miners[uid];
        if (miner) {
          weightSum += miner.weight;
          weightCount++;
          if (miner.weight < worst) worst = miner.weight;
          alerts += cellAlerts(miner).length;
        }
      }
      m.set(uid, {
        avgWeight: weightCount > 0 ? weightSum / weightCount : 0,
        worstWeight: worst === Infinity ? 0 : worst,
        alertCount: alerts,
      });
    }
    return m;
  }, [data]);

  // Sort and filter miner UIDs
  const sortedMiners = useMemo(() => {
    if (!data) return [];
    let uids = [...data.minerUids];

    // Filter by search
    if (search) {
      const q = search.trim();
      if (/^\d+$/.test(q)) {
        uids = uids.filter((u) => String(u).includes(q));
      }
    }

    // Filter alerts only
    if (filterAlerts) {
      uids = uids.filter((u) => (minerMeta.get(u)?.alertCount ?? 0) > 0);
    }

    // Sort
    switch (sortMode) {
      case "uid":
        uids.sort((a, b) => a - b);
        break;
      case "avg-weight":
        uids.sort(
          (a, b) =>
            (minerMeta.get(b)?.avgWeight ?? 0) - (minerMeta.get(a)?.avgWeight ?? 0),
        );
        break;
      case "worst":
        uids.sort(
          (a, b) =>
            (minerMeta.get(a)?.worstWeight ?? 0) - (minerMeta.get(b)?.worstWeight ?? 0),
        );
        break;
      case "alerts":
        uids.sort(
          (a, b) =>
            (minerMeta.get(b)?.alertCount ?? 0) - (minerMeta.get(a)?.alertCount ?? 0),
        );
        break;
    }
    return uids;
  }, [data, sortMode, filterAlerts, search, minerMeta]);

  // Sort validators by stake descending
  const sortedValidators = useMemo(() => {
    if (!data) return [];
    return [...data.validators].sort(
      (a, b) => parseFloat(b.stake) - parseFloat(a.stake),
    );
  }, [data]);

  if (loading) {
    return (
      <div className="h-40 flex items-center justify-center">
        <div className="animate-spin w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-sm text-slate-500 py-6 text-center">
        {error || "Matrix data unavailable."}
      </div>
    );
  }

  if (sortedValidators.length === 0) {
    return (
      <div className="text-sm text-slate-500 py-6 text-center">
        No validators returned scoring data.
      </div>
    );
  }

  const totalAlerts = [...minerMeta.values()].reduce((s, m) => s + m.alertCount, 0);

  return (
    <div>
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          type="text"
          placeholder="Filter by UID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-2 py-1 text-sm border border-slate-300 rounded w-32 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="px-2 py-1 text-sm border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
        >
          <option value="avg-weight">Sort: Avg Weight</option>
          <option value="worst">Sort: Worst Score</option>
          <option value="alerts">Sort: Most Alerts</option>
          <option value="uid">Sort: UID</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={filterAlerts}
            onChange={(e) => setFilterAlerts(e.target.checked)}
            className="rounded border-slate-300"
          />
          Alerts only
          {totalAlerts > 0 && (
            <span className="text-xs text-red-500 font-medium">({totalAlerts})</span>
          )}
        </label>
        <span className="text-xs text-slate-400 ml-auto">
          {sortedValidators.length} validators, {sortedMiners.length} miners
        </span>
      </div>

      <Legend />

      {/* Matrix */}
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              {/* Corner cell */}
              <th className="sticky left-0 z-20 bg-slate-100 border border-slate-200 px-2 py-1.5 text-left text-xs text-slate-500 min-w-[60px]">
                V \ M
              </th>
              {sortedMiners.map((uid) => (
                <th
                  key={uid}
                  className="sticky top-0 z-10 bg-slate-100 border border-slate-200 px-1 py-1.5 font-mono font-medium text-center min-w-[48px]"
                >
                  <Link
                    href={`/network/miner/${uid}`}
                    className="text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    {uid}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedValidators.map((v) => {
              const stats = valStats.get(v.uid) || { median: 0, max: 0 };
              return (
                <tr key={v.uid}>
                  {/* Row header: validator UID */}
                  <th className="sticky left-0 z-10 bg-slate-100 border border-slate-200 px-2 py-1 text-left whitespace-nowrap">
                    <Link
                      href={`/network/validator/${v.uid}`}
                      className="text-blue-600 hover:text-blue-800 hover:underline font-mono font-medium"
                    >
                      {v.uid}
                    </Link>
                    <span className="text-[9px] text-slate-400 ml-1">
                      v{v.version || "?"}
                    </span>
                    {!v.healthy && (
                      <span className="text-[9px] text-red-400 ml-1" title="Validator unhealthy">
                        &#9888;
                      </span>
                    )}
                  </th>
                  {sortedMiners.map((minerUid) => (
                    <MatrixCell
                      key={minerUid}
                      miner={v.miners[minerUid]}
                      medianWeight={stats.median}
                      maxWeight={stats.max}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Timestamp */}
      <p className="text-xs text-slate-400 mt-2 text-right">
        {new Date(data.timestamp).toLocaleTimeString()}
      </p>
    </div>
  );
}
