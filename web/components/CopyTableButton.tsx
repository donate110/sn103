"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Reads a <table> element from the DOM and copies its content as TSV.
 * Attach the returned ref to the table's wrapping <div> or directly to <table>.
 */
export function useCopyTable() {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const table = el.tagName === "TABLE" ? el : el.querySelector("table");
    if (!table) return;

    const rows: string[] = [];
    for (const tr of table.querySelectorAll("tr")) {
      const cells: string[] = [];
      for (const cell of tr.querySelectorAll("th, td")) {
        // Get text content, strip extra whitespace
        const text = (cell as HTMLElement).innerText.replace(/\s+/g, " ").trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells.join("\t"));
    }

    const tsv = rows.join("\n");
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  return { ref, copy, copied };
}

export default function CopyTableButton({ onClick, copied }: { onClick: () => void; copied: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="inline-flex items-center gap-1 px-2 py-1 ml-2 text-xs rounded border border-slate-300 text-slate-500 hover:text-slate-700 hover:border-slate-400 transition-colors bg-white align-middle"
      title="Copy table as text"
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}
