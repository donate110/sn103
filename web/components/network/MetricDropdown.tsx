interface MetricDropdownProps {
  options: { value: string; label: string }[];
  selected: string;
  onChange: (value: string) => void;
}

export default function MetricDropdown({ options, selected, onChange }: MetricDropdownProps) {
  return (
    <select
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 cursor-pointer hover:border-slate-300 transition-colors"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
