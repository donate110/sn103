"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import type { SignalEvent } from "@/lib/events";
import type { GeniusLeaderboardEntry } from "@/lib/types";
import { truncateAddress, formatBps } from "@/lib/types";

const SPORT_COLORS: Record<string, string> = {
  NBA: "#f97316",
  NFL: "#22c55e",
  MLB: "#ef4444",
  NHL: "#3b82f6",
  Soccer: "#a855f7",
};

const SPORT_COLOR_ENTRIES = Object.entries(SPORT_COLORS);

const PADDING = { top: 28, right: 24, bottom: 52, left: 60 };

// Fallback static ranges (used as absolute maximums)
const CONF_ABS_MAX = 6;
const SLA_ABS_MIN = 10000; // 100%

/**
 * Compute nice axis bounds and ticks from actual data.
 * When all values are identical or clustered at a minimum, we use a tight
 * range so dots are visible in the middle of the chart, not smushed at a corner.
 */
function computeAxisRange(
  values: number[],
  absMin: number,
  absMax: number,
  minSpan: number,
  preferredTickCount: number,
): { min: number; max: number; ticks: number[] } {
  if (values.length === 0) {
    return niceRange(absMin, absMax, preferredTickCount);
  }

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const dataSpan = dataMax - dataMin;

  // If all values are identical or nearly so, create a range centered on the value
  // but ensure at least minSpan width
  let lo: number, hi: number;
  if (dataSpan < minSpan * 0.1) {
    // Tight cluster — pad around the center
    const center = (dataMin + dataMax) / 2;
    lo = Math.max(absMin, center - minSpan / 2);
    hi = lo + minSpan;
  } else {
    // Real spread — pad by 15% on each side
    const pad = dataSpan * 0.15;
    lo = Math.max(absMin, dataMin - pad);
    hi = dataMax + pad;
    // Ensure minimum span
    if (hi - lo < minSpan) hi = lo + minSpan;
  }

  return niceRange(lo, hi, preferredTickCount);
}

/** Round to "nice" numbers for axis ticks */
function niceRange(
  lo: number,
  hi: number,
  tickCount: number,
): { min: number; max: number; ticks: number[] } {
  const rawStep = (hi - lo) / Math.max(tickCount - 1, 1);
  // Round step to a nice number (1, 2, 5 multiples of powers of 10)
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / mag;
  let niceStep: number;
  if (residual <= 1.5) niceStep = 1 * mag;
  else if (residual <= 3.5) niceStep = 2 * mag;
  else if (residual <= 7.5) niceStep = 5 * mag;
  else niceStep = 10 * mag;

  const niceMin = Math.floor(lo / niceStep) * niceStep;
  const niceMax = Math.ceil(hi / niceStep) * niceStep;

  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + niceStep * 0.01; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6); // avoid floating point drift
  }

  return { min: niceMin, max: niceMax, ticks };
}

// Dot sizing: radius 8 to 18 based on inverse fee
const MIN_DOT_R = 8;
const MAX_DOT_R = 18;
const HOVER_EXTRA = 4;

export interface GeniusStats {
  qualityScore: number;
  totalSignals: number;
  roi: number;
  proofCount: number;
  favCount: number;
  unfavCount: number;
}

interface SignalPlotProps {
  signals: SignalEvent[];
  onSelect: (signalId: string) => void;
  geniusScoreMap?: Map<string, GeniusStats>;
}

interface TooltipData {
  sport: string;
  genius: string;
  fee: string;
  sla: string;
  hoursLeft: number;
  confidence: number;
  winRate: string;
  n: number;
  roi: string;
  x: number;
  y: number;
}

function computeConfidence(stats: GeniusStats | undefined): number {
  if (!stats) return 0;
  const n = stats.favCount + stats.unfavCount;
  if (n === 0) return 0;
  const winRate = stats.favCount / n;
  return winRate * Math.log2(n + 1);
}

function feeToRadius(feeBps: number): number {
  // Cheaper signals get bigger dots (more attractive)
  // Fee range: 50 bps (0.5%) to 500 bps (5%)
  const normalized = 1 - Math.min(1, Math.max(0, (feeBps - 50) / 450));
  return MIN_DOT_R + normalized * (MAX_DOT_R - MIN_DOT_R);
}

export default function SignalPlot({
  signals,
  onSelect,
  geniusScoreMap,
}: SignalPlotProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 420 });

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const w = Math.max(320, entry.contentRect.width);
        const h = Math.max(300, Math.min(520, w * 0.65));
        setDimensions({ width: w, height: h });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotWidth = dimensions.width - PADDING.left - PADDING.right;
  const plotHeight = dimensions.height - PADDING.top - PADDING.bottom;

  // Pre-compute raw data values so we can derive dynamic axes
  const rawData = useMemo(() => {
    return signals.map((s) => {
      const fee = Number(s.maxPriceBps);
      const sla = Number(s.slaMultiplierBps);
      const expires = new Date(Number(s.expiresAt) * 1000);
      const hoursLeft = Math.max(
        0,
        (expires.getTime() - Date.now()) / 3_600_000,
      );
      const stats = geniusScoreMap?.get(s.genius.toLowerCase());
      const confidence = computeConfidence(stats);
      const n = stats ? stats.favCount + stats.unfavCount : 0;
      const winRate =
        n > 0 && stats ? ((stats.favCount / n) * 100).toFixed(0) : "\u2014";
      const roi = stats ? `${stats.roi >= 0 ? "+" : ""}${stats.roi.toFixed(1)}%` : "\u2014";
      const r = feeToRadius(fee);
      return { signal: s, fee, sla, hoursLeft, confidence, n, winRate, roi, r };
    });
  }, [signals, geniusScoreMap]);

  // Dynamic axis ranges based on actual data
  const xAxis = useMemo(() => {
    const confValues = rawData.map((d) => d.confidence);
    // minSpan=1 so even if all confidence=0 we show 0..1 range
    return computeAxisRange(confValues, 0, CONF_ABS_MAX, 1, 5);
  }, [rawData]);

  const yAxis = useMemo(() => {
    const slaValues = rawData.map((d) => d.sla);
    // minSpan=5000 bps (50%) — tight enough to spread dots on early testnet
    return computeAxisRange(slaValues, SLA_ABS_MIN, 30000, 5000, 5);
  }, [rawData]);

  const toX = useCallback(
    (confidence: number) => {
      const span = xAxis.max - xAxis.min;
      if (span === 0) return PADDING.left + plotWidth / 2;
      const clamped = Math.max(xAxis.min, Math.min(xAxis.max, confidence));
      return PADDING.left + ((clamped - xAxis.min) / span) * plotWidth;
    },
    [plotWidth, xAxis],
  );

  const toY = useCallback(
    (slaBps: number) => {
      const span = yAxis.max - yAxis.min;
      if (span === 0) return PADDING.top + plotHeight / 2;
      const clamped = Math.max(yAxis.min, Math.min(yAxis.max, slaBps));
      return (
        PADDING.top +
        plotHeight -
        ((clamped - yAxis.min) / span) * plotHeight
      );
    },
    [plotHeight, yAxis],
  );

  // Deterministic jitter: when multiple dots map to the same pixel location,
  // offset them slightly so they don't perfectly overlap.
  const jitter = useCallback(
    (signalId: string, index: number, total: number) => {
      if (total <= 1) return { dx: 0, dy: 0 };
      // Simple hash from signalId for deterministic scatter
      let hash = 0;
      for (let i = 0; i < signalId.length; i++) {
        hash = (hash * 31 + signalId.charCodeAt(i)) | 0;
      }
      const angle = ((hash % 360) / 360) * Math.PI * 2;
      const maxOffset = Math.min(plotWidth, plotHeight) * 0.04;
      const radius = maxOffset * (0.4 + 0.6 * ((index % 7) / 6));
      return { dx: Math.cos(angle) * radius, dy: Math.sin(angle) * radius };
    },
    [plotWidth, plotHeight],
  );

  // Check if dots would cluster (all same pixel position)
  const dots = useMemo(() => {
    const preliminary = rawData.map((d) => ({
      ...d,
      cx: toX(d.confidence),
      cy: toY(d.sla),
      color: SPORT_COLORS[d.signal.sport] || "#6b7280",
    }));

    // Detect clustering: if all cx/cy are within 2px of each other, apply jitter
    const allSameSpot =
      preliminary.length > 1 &&
      preliminary.every(
        (p) =>
          Math.abs(p.cx - preliminary[0].cx) < 2 &&
          Math.abs(p.cy - preliminary[0].cy) < 2,
      );

    if (allSameSpot) {
      return preliminary.map((p, i) => {
        const j = jitter(p.signal.signalId, i, preliminary.length);
        return { ...p, cx: p.cx + j.dx, cy: p.cy + j.dy };
      });
    }
    return preliminary;
  }, [rawData, toX, toY, jitter]);

  const handleDotEnter = (
    dot: (typeof dots)[0],
    event: React.MouseEvent | React.TouchEvent,
  ) => {
    setHoveredId(dot.signal.signalId);
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;

    let clientX: number, clientY: number;
    if ("touches" in event) {
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    setTooltip({
      sport: dot.signal.sport,
      genius: truncateAddress(dot.signal.genius),
      fee: `${(dot.fee / 100).toFixed(1)}%`,
      sla: formatBps(BigInt(dot.sla)),
      hoursLeft: dot.hoursLeft,
      confidence: dot.confidence,
      winRate: dot.winRate,
      n: dot.n,
      roi: dot.roi,
      x: clientX - svgRect.left,
      y: clientY - svgRect.top,
    });
  };

  const handleDotLeave = () => {
    setHoveredId(null);
    setTooltip(null);
  };

  const formatTimeLeft = (hours: number): string => {
    if (hours < 1) return `${Math.round(hours * 60)}m left`;
    if (hours < 24) return `${Math.round(hours)}h left`;
    return `${Math.floor(hours / 24)}d left`;
  };

  // Format tick labels based on magnitude
  const formatConfTick = (tick: number): string => {
    if (Number.isInteger(tick)) return String(tick);
    return tick.toFixed(1);
  };

  const formatSlaTick = (tick: number): string => `${tick / 100}%`;

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Quadrant hint: top-right is the sweet spot */}
      <div className="absolute top-0 right-0 text-[10px] text-slate-300 pr-2 pt-1 pointer-events-none select-none hidden sm:block">
        best &uarr;&rarr;
      </div>

      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        className="select-none"
        role="img"
        aria-label="Signal scatter plot: genius confidence vs SLA, colored by sport, sized by fee"
      >
        {/* Background quadrant shading — top-right is "ideal" */}
        <rect
          x={toX((xAxis.min + xAxis.max) / 2)}
          y={PADDING.top}
          width={plotWidth / 2}
          height={plotHeight / 2}
          fill="#f0fdf4"
          opacity={0.4}
        />

        {/* Grid lines */}
        {xAxis.ticks.map((tick) => (
          <line
            key={`gx-${tick}`}
            x1={toX(tick)}
            y1={PADDING.top}
            x2={toX(tick)}
            y2={PADDING.top + plotHeight}
            stroke="#e2e8f0"
            strokeWidth={1}
          />
        ))}
        {yAxis.ticks.map((tick) => (
          <line
            key={`gy-${tick}`}
            x1={PADDING.left}
            y1={toY(tick)}
            x2={PADDING.left + plotWidth}
            y2={toY(tick)}
            stroke="#e2e8f0"
            strokeWidth={1}
          />
        ))}

        {/* Axes */}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={PADDING.left + plotWidth}
          y2={PADDING.top + plotHeight}
          stroke="#94a3b8"
          strokeWidth={1}
        />
        <line
          x1={PADDING.left}
          y1={PADDING.top}
          x2={PADDING.left}
          y2={PADDING.top + plotHeight}
          stroke="#94a3b8"
          strokeWidth={1}
        />

        {/* X axis labels */}
        {xAxis.ticks.map((tick) => (
          <text
            key={`lx-${tick}`}
            x={toX(tick)}
            y={PADDING.top + plotHeight + 20}
            textAnchor="middle"
            className="fill-slate-500 text-[11px]"
          >
            {formatConfTick(tick)}
          </text>
        ))}
        <text
          x={PADDING.left + plotWidth / 2}
          y={dimensions.height - 4}
          textAnchor="middle"
          className="fill-slate-400 text-[11px]"
        >
          Genius Confidence (win rate x track record depth)
        </text>

        {/* Y axis labels */}
        {yAxis.ticks.map((tick) => (
          <text
            key={`ly-${tick}`}
            x={PADDING.left - 8}
            y={toY(tick) + 4}
            textAnchor="end"
            className="fill-slate-500 text-[11px]"
          >
            {formatSlaTick(tick)}
          </text>
        ))}
        <text
          x={14}
          y={PADDING.top + plotHeight / 2}
          textAnchor="middle"
          className="fill-slate-400 text-[11px]"
          transform={`rotate(-90, 14, ${PADDING.top + plotHeight / 2})`}
        >
          SLA (skin in game)
        </text>

        {/* Dots — sorted so smaller dots render on top for clickability */}
        {[...dots]
          .sort((a, b) => b.r - a.r)
          .map((dot) => {
            const isHovered = hoveredId === dot.signal.signalId;
            const r = isHovered ? dot.r + HOVER_EXTRA : dot.r;
            // Urgency opacity: expires <2h = full, >24h = slightly faded
            const urgencyOpacity = Math.max(
              0.55,
              Math.min(1, 1 - (dot.hoursLeft - 2) / 48),
            );
            return (
              <g key={dot.signal.signalId}>
                <circle
                  cx={dot.cx}
                  cy={dot.cy}
                  r={r + 8}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={() => onSelect(dot.signal.signalId)}
                  onMouseEnter={(e) => handleDotEnter(dot, e)}
                  onMouseLeave={handleDotLeave}
                  onTouchStart={(e) => handleDotEnter(dot, e)}
                  onTouchEnd={() => {
                    handleDotLeave();
                    onSelect(dot.signal.signalId);
                  }}
                />
                <circle
                  cx={dot.cx}
                  cy={dot.cy}
                  r={r}
                  fill={dot.color}
                  fillOpacity={isHovered ? 1 : urgencyOpacity}
                  stroke={isHovered ? "#1e293b" : "white"}
                  strokeWidth={isHovered ? 2.5 : 1.5}
                  className="pointer-events-none transition-all duration-150"
                />
                {/* Fee label inside dot if large enough */}
                {dot.r >= 12 && (
                  <text
                    x={dot.cx}
                    y={dot.cy + 1}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="pointer-events-none fill-white font-semibold"
                    fontSize={dot.r >= 15 ? 10 : 8}
                  >
                    {(dot.fee / 100).toFixed(0)}%
                  </text>
                )}
              </g>
            );
          })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="absolute z-10 rounded-lg bg-slate-900 text-white px-3 py-2 text-xs shadow-lg pointer-events-none min-w-[180px]"
          style={{
            left: Math.min(tooltip.x + 16, dimensions.width - 200),
            top: Math.max(0, tooltip.y - 100),
          }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold">{tooltip.sport}</span>
            <span className="text-slate-400">{formatTimeLeft(tooltip.hoursLeft)}</span>
          </div>
          <p className="text-slate-300 mb-1.5">by {tooltip.genius}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
            <span className="text-slate-400">Fee</span>
            <span>{tooltip.fee}</span>
            <span className="text-slate-400">SLA</span>
            <span>{tooltip.sla}</span>
            <span className="text-slate-400">Win Rate</span>
            <span>{tooltip.winRate}{tooltip.n > 0 ? `% (${tooltip.n})` : ""}</span>
            <span className="text-slate-400">ROI</span>
            <span>{tooltip.roi}</span>
            <span className="text-slate-400">Confidence</span>
            <span>{tooltip.confidence.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 px-1">
        <div className="flex flex-wrap gap-3">
          {SPORT_COLOR_ENTRIES.map(([sport, color]) => (
            <div key={sport} className="flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs text-slate-500">{sport}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
          <svg width="14" height="14"><circle cx="7" cy="7" r="4" fill="#94a3b8" /></svg>
          <span>expensive</span>
          <svg width="22" height="22"><circle cx="11" cy="11" r="9" fill="#94a3b8" /></svg>
          <span>cheap</span>
        </div>
      </div>
    </div>
  );
}
