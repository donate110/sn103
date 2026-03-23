interface ScoreTreeProps {
  breakdown: Record<string, number | boolean | string>;
  weight?: number;
}

function Val({ v, pct }: { v: number | boolean | string | undefined; pct?: boolean }) {
  if (v === undefined) return <span className="text-slate-300">-</span>;
  if (typeof v === "boolean") return <span className="font-mono text-sm font-semibold">{v ? "Yes" : "No"}</span>;
  const num = Number(v);
  if (isNaN(num)) return <span className="font-mono text-sm font-semibold">{String(v)}</span>;
  const display = pct ? `${(num * 100).toFixed(1)}%` : num.toFixed(4);
  return <span className="font-mono text-sm font-semibold">{display}</span>;
}

function Bar({ value, color }: { value: number; color: string }) {
  const width = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="h-1.5 w-full bg-slate-100 rounded-full mt-1">
      <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
    </div>
  );
}

function Row({
  label,
  value,
  pct,
  color,
  indent,
}: {
  label: string;
  value: number | boolean | string | undefined;
  pct?: boolean;
  color?: string;
  indent?: number;
}) {
  const numVal = typeof value === "number" ? value : undefined;
  return (
    <div className="py-1.5" style={{ paddingLeft: `${(indent ?? 0) * 16}px` }}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs text-slate-500">{label}</span>
        <Val v={value} pct={pct} />
      </div>
      {numVal !== undefined && numVal >= 0 && numVal <= 1 && color && (
        <Bar value={numVal} color={color} />
      )}
    </div>
  );
}

export default function ScoreTree({ breakdown, weight }: ScoreTreeProps) {
  const b = breakdown;
  const sports = "#3b82f6"; // blue
  const attest = "#a855f7"; // purple
  const modifier = "#64748b"; // slate

  return (
    <div className="divide-y divide-slate-100">
      {/* Final weight */}
      {weight !== undefined && (
        <Row label="Final Weight" value={weight} color={sports} />
      )}

      {/* Final scores */}
      <div className="py-2">
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Final Scores</p>
        <Row label="Sports Score" value={b.sports_score as number} color={sports} indent={1} />
        <Row label="Attestation Score" value={b.attestation_score as number} color={attest} indent={1} />
        <Row label="Raw Score" value={b.raw_score as number} color={modifier} indent={1} />
      </div>

      {/* Sports components */}
      <div className="py-2">
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Sports Components</p>
        <Row label="Accuracy (35%)" value={b.accuracy as number} color={sports} indent={1} />
        <Row label="Speed (25%)" value={b.speed as number} color={sports} indent={1} />
        <Row label="Coverage (15%)" value={b.coverage as number} color={sports} indent={1} />
        <Row label="Uptime (15%)" value={b.uptime as number} color={sports} indent={1} />
        <Row label="Capability (10%)" value={b.capability_score as number} color={sports} indent={1} />
      </div>

      {/* Attestation components */}
      {(b.attest_validity !== undefined || b.attestation_score !== undefined) && (
        <div className="py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">Attestation Components</p>
          {b.attest_validity !== undefined && (
            <Row label="Proof Validity (60%)" value={b.attest_validity as number} color={attest} indent={1} />
          )}
          {b.attest_speed !== undefined && (
            <Row label="Speed (40%)" value={b.attest_speed as number} color={attest} indent={1} />
          )}
        </div>
      )}

      {/* Modifiers */}
      <div className="py-2">
        <p className="text-[10px] text-slate-400 uppercase tracking-wide mb-1">History & Notary</p>
        <Row label="Consecutive Epochs" value={b.consecutive_epochs as number} indent={1} />
        <Row label="Notary Reliability" value={b.notary_reliability as number} pct color={modifier} indent={1} />
        <Row label="Notary Capable" value={b.notary_capable as boolean} indent={1} />
      </div>
    </div>
  );
}
