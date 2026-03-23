import { useCallback, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

export function formatStake(raw: string): string {
  const tao = parseFloat(raw) / 1e9;
  if (tao >= 1000) return `${(tao / 1000).toFixed(1)}k`;
  if (tao >= 1) return tao.toFixed(1);
  return tao.toFixed(4);
}

export function u16ToPercent(val: number): string {
  return ((val / 65535) * 100).toFixed(2) + "%";
}

export function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) weightedSum += (i + 1) * sorted[i];
  return (2 * weightedSum) / (n * total) - (n + 1) / n;
}

export function useSortable<T>(
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
      else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey],
  );
  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const va = getVal(a, sortKey);
      const vb = getVal(b, sortKey);
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [items, sortKey, sortDir, getVal]);
  return { sorted, sortKey, sortDir, toggle };
}
