"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useBrowseSignals } from "@/lib/hooks/useBrowseSignals";
import { useActiveRelationships } from "@/lib/hooks/useActiveRelationships";
import { formatUsdc, formatBps, truncateAddress } from "@/lib/types";

type SortOption = "expiry" | "fee" | "sla" | "relationship";

const SPORT_OPTIONS = [
  { value: "", label: "All Sports" },
  { value: "NFL", label: "NFL" },
  { value: "NBA", label: "NBA" },
  { value: "MLB", label: "MLB" },
  { value: "NHL", label: "NHL" },
  { value: "Soccer", label: "Soccer" },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "expiry", label: "Expiry (soonest)" },
  { value: "relationship", label: "My relationships" },
  { value: "fee", label: "Fee (lowest)" },
  { value: "sla", label: "SLA (highest)" },
];

export default function BrowseSignals() {
  const { address } = useAccount();
  const [sportFilter, setSportFilter] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("expiry");
  const { signals, loading, error: signalError } = useBrowseSignals(sportFilter || undefined);
  const { relationships } = useActiveRelationships(address, "idiot");

  const geniusesWithOpenAuditSets = useMemo(() => {
    const set = new Set<string>();
    for (const rel of relationships) {
      if (rel.signalCount > 0 && rel.signalCount < 10) {
        set.add(rel.genius.toLowerCase());
      }
    }
    return set;
  }, [relationships]);

  const sortedSignals = useMemo(() => {
    const copy = [...signals];
    switch (sortBy) {
      case "expiry":
        copy.sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt));
        break;
      case "fee":
        copy.sort((a, b) => Number(a.maxPriceBps) - Number(b.maxPriceBps));
        break;
      case "sla":
        copy.sort(
          (a, b) => Number(b.slaMultiplierBps) - Number(a.slaMultiplierBps),
        );
        break;
      case "relationship":
        copy.sort((a, b) => {
          const aHas = geniusesWithOpenAuditSets.has(a.genius.toLowerCase()) ? 1 : 0;
          const bHas = geniusesWithOpenAuditSets.has(b.genius.toLowerCase()) ? 1 : 0;
          if (bHas !== aHas) return bHas - aHas;
          return Number(a.expiresAt) - Number(b.expiresAt);
        });
        break;
    }
    return copy;
  }, [signals, sortBy, geniusesWithOpenAuditSets]);

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/idiot"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-idiot-600 transition-colors mb-4"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
            />
          </svg>
          Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold text-slate-900">Browse Signals</h1>
        <p className="text-slate-500 mt-1">
          Discover and purchase signals from top-performing Geniuses
        </p>
      </div>

      {/* Filters & Sort */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <div>
            <label
              htmlFor="sportFilter"
              className="sr-only"
            >
              Filter by sport
            </label>
            <select
              id="sportFilter"
              className="input w-auto"
              value={sportFilter}
              onChange={(e) => setSportFilter(e.target.value)}
              disabled={loading}
            >
              {SPORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="sortBy"
              className="sr-only"
            >
              Sort by
            </label>
            <select
              id="sortBy"
              className="input w-auto"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              disabled={loading}
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-xs text-slate-400">
          {loading ? "Loading..." : `${sortedSignals.length} signal${sortedSignals.length !== 1 ? "s" : ""} available`}
        </p>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="flex justify-between mb-3">
                <div className="h-5 bg-slate-200 rounded w-12" />
                <div className="h-5 bg-slate-100 rounded w-16" />
              </div>
              <div className="h-4 bg-slate-100 rounded w-24 mb-4" />
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="h-3 bg-slate-100 rounded w-14 mb-1" />
                  <div className="h-5 bg-slate-200 rounded w-12" />
                </div>
                <div>
                  <div className="h-3 bg-slate-100 rounded w-8 mb-1" />
                  <div className="h-5 bg-slate-200 rounded w-10" />
                </div>
                <div>
                  <div className="h-3 bg-slate-100 rounded w-20 mb-1" />
                  <div className="h-5 bg-slate-200 rounded w-12" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : signalError ? (
        <div className="card">
          <div className="flex flex-col items-center justify-center py-16">
            <p className="text-red-600 font-medium mb-1">Failed to load signals</p>
            <p className="text-sm text-slate-500 text-center max-w-sm">{signalError}</p>
          </div>
        </div>
      ) : sortedSignals.length === 0 ? (
        <div className="card">
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <svg
                className="w-7 h-7 text-slate-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
            </div>
            <p className="text-slate-900 font-medium mb-1">No signals found</p>
            <p className="text-sm text-slate-500 text-center max-w-sm">
              {sportFilter
                ? `No active signals for ${sportFilter} right now. Try selecting a different sport or check back later.`
                : "No signals available right now. Check back soon; new signals are committed as Geniuses publish their analysis."}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedSignals.map((s) => {
            const feePerHundred = (
              (100 * Number(s.maxPriceBps)) /
              10_000
            ).toFixed(2);
            const slaPercent = formatBps(s.slaMultiplierBps);
            const expires = new Date(Number(s.expiresAt) * 1000);
            const msLeft = Math.max(0, expires.getTime() - Date.now());
            const hoursLeft = msLeft / 3_600_000;
            const isUrgent = hoursLeft < 2;
            const isExclusive = s.minNotional > 0n && s.minNotional === s.maxNotional;

            let timeLabel: string;
            if (hoursLeft < 1) {
              const minsLeft = Math.round(msLeft / 60_000);
              timeLabel = `${minsLeft}m left`;
            } else if (hoursLeft < 24) {
              timeLabel = `${Math.round(hoursLeft)}h left`;
            } else {
              const daysLeft = Math.floor(hoursLeft / 24);
              timeLabel = `${daysLeft}d left`;
            }

            return (
              <Link
                key={s.signalId}
                href={`/idiot/signal/${s.signalId}`}
                className="card block hover:border-idiot-300 hover:shadow-md transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center rounded-full bg-idiot-50 px-2.5 py-0.5 text-xs font-medium text-idiot-700">
                      {s.sport}
                    </span>
                    {isExclusive && (
                      <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wide">
                        Exclusive
                      </span>
                    )}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      isUrgent
                        ? "bg-red-50 text-red-600"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {timeLabel}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-sm text-slate-500 mb-4">
                  <span>
                    by{" "}
                    <span className="font-medium text-slate-700">
                      {truncateAddress(s.genius)}
                    </span>
                  </span>
                  {geniusesWithOpenAuditSets.has(s.genius.toLowerCase()) && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-idiot-100 text-idiot-700">
                      Open audit set
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 mb-4">
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wide">
                      Fee / $100
                    </p>
                    <p className="text-sm font-semibold text-slate-900 mt-0.5">
                      ${feePerHundred}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wide">
                      SLA
                    </p>
                    <p className="text-sm font-semibold text-slate-900 mt-0.5">
                      {slaPercent}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400 uppercase tracking-wide">
                      Max Notional
                    </p>
                    <p className="text-sm font-semibold text-slate-900 mt-0.5">
                      ${formatUsdc(s.maxNotional)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-end">
                  <span className="text-xs text-idiot-500 font-medium">
                    View Signal &rarr;
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
