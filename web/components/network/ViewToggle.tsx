interface ViewToggleProps {
  view: "chart" | "table";
  onChange: (view: "chart" | "table") => void;
}

export default function ViewToggle({ view, onChange }: ViewToggleProps) {
  const base = "px-3 py-1 text-xs font-medium rounded-md transition-colors";
  const active = "bg-slate-900 text-white";
  const inactive = "bg-slate-100 text-slate-500 hover:bg-slate-200";

  return (
    <div className="inline-flex gap-1 rounded-lg bg-slate-50 p-0.5">
      <button
        className={`${base} ${view === "chart" ? active : inactive}`}
        onClick={() => onChange("chart")}
      >
        Chart
      </button>
      <button
        className={`${base} ${view === "table" ? active : inactive}`}
        onClick={() => onChange("table")}
      >
        Table
      </button>
    </div>
  );
}
