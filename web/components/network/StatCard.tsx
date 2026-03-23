interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
}

export default function StatCard({ label, value, sub, delta }: StatCardProps) {
  return (
    <div className="card text-center">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
        {delta != null && delta !== 0 && (
          <span
            className={`text-[11px] font-medium ${
              delta > 0 ? "text-emerald-600" : "text-red-500"
            }`}
          >
            {delta > 0 ? "\u25B2" : "\u25BC"} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="text-2xl font-bold font-mono">{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}
