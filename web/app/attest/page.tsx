"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface AttestResult {
  request_id: string;
  url: string;
  success: boolean;
  verified: boolean;
  proof_hex: string | null;
  response_body: string | null;
  server_name: string | null;
  timestamp: number;
  error: string | null;
}

type Status = "idle" | "submitting" | "proving" | "done" | "error";

interface BatchItem {
  url: string;
  status: Status;
  result: AttestResult | null;
  error: string | null;
  startedAt?: number;
  elapsed?: number;
}

function useElapsedTimer(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);
  return elapsed;
}

export default function AttestPage() {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [url, setUrl] = useState("");
  const [batchUrls, setBatchUrls] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<AttestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const elapsed = useElapsedTimer(status === "proving");

  const attestSingle = useCallback(
    async (targetUrl: string): Promise<AttestResult | null> => {
      const requestId = `attest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resp = await fetch("/api/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          request_id: requestId,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Request failed" }));
        throw new Error(data.detail || data.error || `Request failed (${resp.status})`);
      }

      return await resp.json();
    },
    [],
  );

  const handleSingleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.startsWith("https://")) {
        setErrorMsg("URL must start with https://");
        return;
      }

      setStatus("proving");
      setResult(null);
      setErrorMsg(null);

      try {
        const data = await attestSingle(url);
        setResult(data);
        setStatus("done");
        if (data && !data.success) {
          setErrorMsg(data.error || "Attestation failed");
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : "Network error");
        setStatus("error");
      }
    },
    [url, attestSingle],
  );

  const handleBatchSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const urls = batchUrls
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      if (urls.length === 0) {
        setErrorMsg("Enter at least one URL");
        return;
      }

      const invalid = urls.filter((u) => !u.startsWith("https://"));
      if (invalid.length > 0) {
        setErrorMsg(`All URLs must start with https://. Invalid: ${invalid[0]}`);
        return;
      }

      setErrorMsg(null);
      setBatchRunning(true);

      const items: BatchItem[] = urls.map((u) => ({
        url: u,
        status: "idle",
        result: null,
        error: null,
      }));
      setBatchItems([...items]);

      for (let i = 0; i < items.length; i++) {
        items[i].status = "proving";
        setBatchItems([...items]);

        try {
          const data = await attestSingle(items[i].url);
          items[i].result = data;
          items[i].status = data?.success ? "done" : "error";
          items[i].error = data?.success ? null : (data?.error || "Failed");
        } catch (err) {
          items[i].status = "error";
          items[i].error = err instanceof Error ? err.message : "Network error";
        }

        setBatchItems([...items]);
      }

      setBatchRunning(false);
    },
    [batchUrls, attestSingle],
  );

  const handleDownload = useCallback(
    (proofHex: string, timestamp: number) => {
      const matches = proofHex.match(/.{1,2}/g);
      if (!matches) return;
      const bytes = new Uint8Array(
        matches.map((b) => parseInt(b, 16)),
      );
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `attestation-${timestamp}.bin`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    [],
  );

  const parsedBatchCount = batchUrls
    .split("\n")
    .filter((u) => u.trim().length > 0).length;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Web Attestation</h1>
        <p className="text-slate-500 mt-1">
          Generate cryptographic TLSNotary proofs that websites served specific content at a
          specific time. Free and powered by Bittensor Subnet 103.
        </p>
      </div>

      {/* Step-by-step instructions */}
      <div className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">How it works</h2>
        <ol className="space-y-3 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">1</span>
            <span>
              <strong>Enter a URL.</strong> Paste any public HTTPS URL you want to prove. For multiple pages, switch to batch mode.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">2</span>
            <span>
              <strong>Wait for the proof.</strong> A miner on Bittensor Subnet 103 generates a TLSNotary proof (30-90 seconds per page). The validator verifies it.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">3</span>
            <span>
              <strong>Download your proof.</strong> The cryptographic proof file is tamper-proof and verifiable by anyone.
            </span>
          </li>
        </ol>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setMode("single")}
          className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
            mode === "single"
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
          }`}
        >
          Single URL
        </button>
        <button
          onClick={() => setMode("batch")}
          className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
            mode === "batch"
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
          }`}
        >
          Batch (multiple URLs)
        </button>
      </div>

      {/* Form */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <form onSubmit={mode === "single" ? handleSingleSubmit : handleBatchSubmit}>
          {mode === "single" ? (
            <>
              <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="attest-url">
                URL to attest
              </label>
              <input
                id="attest-url"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-slate-500 focus:border-slate-500"
                type="url"
                placeholder="https://example.com/page"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                disabled={status === "proving"}
              />
              <p className="text-xs text-slate-400 mt-1">Must be an HTTPS URL.</p>
            </>
          ) : (
            <>
              <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="batch-urls">
                URLs to attest (one per line)
              </label>
              <textarea
                id="batch-urls"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-slate-500 focus:border-slate-500"
                rows={6}
                placeholder={"https://example.com/page1\nhttps://example.com/page2\nhttps://example.com/page3"}
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                disabled={batchRunning}
              />
              {parsedBatchCount > 0 && (
                <p className="text-xs text-slate-500 mt-1">
                  {parsedBatchCount} URL{parsedBatchCount !== 1 ? "s" : ""}
                </p>
              )}
            </>
          )}

          <button
            type="submit"
            className="mt-4 w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={
              status === "proving" ||
              batchRunning ||
              (mode === "single" ? !url : parsedBatchCount === 0)
            }
          >
            {(status === "proving" || batchRunning) ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Generating proof{mode === "batch" ? "s" : ""}... {elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
              </>
            ) : (
              <>Attest {mode === "batch" && parsedBatchCount > 0 ? `${parsedBatchCount} URL${parsedBatchCount !== 1 ? "s" : ""}` : ""}</>
            )}
          </button>
        </form>
      </div>

      {/* Error message */}
      {errorMsg && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMsg}
        </div>
      )}

      {/* Single result */}
      {mode === "single" && result && result.success && (
        <ResultCard result={result} onDownload={handleDownload} />
      )}

      {/* Batch results */}
      {mode === "batch" && batchItems.length > 0 && (
        <div className="mt-6 space-y-3">
          <h2 className="text-lg font-semibold text-slate-900">
            Results ({batchItems.filter((i) => i.status === "done").length}/{batchItems.length})
          </h2>
          {batchItems.map((item, idx) => (
            <div
              key={idx}
              className={`rounded-lg border p-4 text-sm ${
                item.status === "done"
                  ? "border-green-200 bg-green-50"
                  : item.status === "error"
                    ? "border-red-200 bg-red-50"
                    : item.status === "proving"
                      ? "border-blue-200 bg-blue-50"
                      : "border-slate-200 bg-white"
              }`}
            >
              <div className="flex items-center gap-2">
                {item.status === "proving" && (
                  <svg className="animate-spin h-4 w-4 text-blue-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {item.status === "done" && (
                  <span className="text-green-600 font-bold">&#10003;</span>
                )}
                {item.status === "error" && (
                  <span className="text-red-600 font-bold">&#10007;</span>
                )}
                {item.status === "idle" && (
                  <span className="text-slate-400">&#9711;</span>
                )}
                <span className="font-mono text-xs break-all flex-1">{item.url}</span>
                {item.result?.proof_hex && (
                  <button
                    onClick={() => handleDownload(item.result!.proof_hex!, item.result!.timestamp)}
                    className="text-xs text-blue-600 hover:text-blue-800 underline flex-shrink-0"
                  >
                    Download
                  </button>
                )}
              </div>
              {item.error && (
                <p className="mt-1 text-xs text-red-600 ml-6">{item.error}</p>
              )}
              {item.result?.verified && (
                <p className="mt-1 text-xs text-green-600 ml-6">
                  Verified &middot; {item.result.server_name} &middot;{" "}
                  {new Date(item.result.timestamp * 1000).toLocaleString()}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* API Documentation (collapsible) */}
      <div className="mt-8 rounded-lg border border-slate-200 bg-white overflow-hidden">
        <button
          onClick={() => setShowApi(!showApi)}
          className="w-full flex items-center justify-between p-4 text-left hover:bg-slate-50 transition-colors"
        >
          <span className="font-semibold text-slate-900">API Documentation</span>
          <span className="text-slate-400 text-lg">{showApi ? "\u2212" : "+"}</span>
        </button>
        {showApi && (
          <div className="px-4 pb-4 text-sm text-slate-700 space-y-4 border-t border-slate-100 pt-4">
            <p>
              You can integrate attestation directly into your application. All endpoints accept JSON.
            </p>
            <div>
              <h4 className="font-semibold text-slate-800 mb-1">POST /api/attest</h4>
              <p className="text-slate-500 mb-2">Generate a TLSNotary proof for a URL.</p>
              <pre className="bg-slate-800 text-slate-100 rounded-lg p-3 text-xs overflow-x-auto">{`curl -X POST https://djinn.gg/api/attest \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://example.com/page",
    "request_id": "my-unique-id"
  }'`}</pre>
              <p className="text-xs text-slate-400 mt-1">
                Response includes <code className="bg-slate-100 px-1 rounded">proof_hex</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">verified</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">server_name</code>, and{" "}
                <code className="bg-slate-100 px-1 rounded">timestamp</code>.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-800 mb-1">Batch attestation</h4>
              <p className="text-slate-500">
                To attest multiple pages, call <code className="bg-slate-100 px-1 rounded">POST /api/attest</code> once
                per URL. Each request is processed sequentially by a random miner on Subnet 103.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* What is TLSNotary */}
      <div className="mt-8 text-sm text-slate-500 space-y-2 pb-12">
        <h3 className="font-semibold text-slate-700">What is a TLSNotary proof?</h3>
        <p>
          TLSNotary uses multi-party computation during the TLS handshake to produce a
          cryptographic proof that a specific web server sent specific content. Unlike
          screenshots or web archives, this proof is tamper-proof and cryptographically
          verifiable by anyone.
        </p>
        <p>
          Use cases include legal evidence, journalism verification, governance transparency,
          and academic citations with permanent, cryptographic provenance.
        </p>
      </div>
    </div>
  );
}

function ResultCard({
  result,
  onDownload,
}: {
  result: AttestResult;
  onDownload: (proofHex: string, timestamp: number) => void;
}) {
  const [viewMode, setViewMode] = useState<"source" | "preview">("source");
  const [copied, setCopied] = useState(false);

  const proofFingerprint =
    result.proof_hex && result.proof_hex.length >= 2
      ? result.proof_hex.slice(0, 32)
      : null;

  const hasBody = !!result.response_body;

  const copySource = useCallback(async () => {
    if (!result.response_body) return;
    try {
      await navigator.clipboard.writeText(result.response_body);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = result.response_body;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [result.response_body]);

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
      <div className="flex items-center gap-2 mb-4">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            result.verified
              ? "bg-green-100 text-green-700 border border-green-200"
              : "bg-amber-100 text-amber-700 border border-amber-200"
          }`}
        >
          {result.verified ? "Verified" : "Unverified"}
        </span>
        <h2 className="text-lg font-semibold text-slate-900">Attestation Result</h2>
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-slate-500">URL</dt>
          <dd className="font-mono text-slate-900 break-all">{result.url}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Server</dt>
          <dd className="font-mono text-slate-900">{result.server_name || "\u2014"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Timestamp</dt>
          <dd className="text-slate-900">
            {result.timestamp
              ? new Date(result.timestamp * 1000).toLocaleString()
              : "\u2014"}
          </dd>
        </div>
        {proofFingerprint && (
          <div>
            <dt className="text-slate-500">Proof fingerprint</dt>
            <dd className="font-mono text-xs text-slate-600">{proofFingerprint}...</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-500">Proof size</dt>
          <dd className="text-slate-900">
            {result.proof_hex
              ? `${(result.proof_hex.length / 2).toLocaleString()} bytes`
              : "\u2014"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center gap-2">
        {result.proof_hex && (
          <button
            onClick={() => onDownload(result.proof_hex!, result.timestamp)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Download proof
          </button>
        )}
      </div>

      {/* Response body viewer */}
      {hasBody && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">Response Content</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={copySource}
                className="rounded-md px-2.5 py-1 text-xs font-medium border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
              >
                {copied ? "Copied!" : "Copy HTML"}
              </button>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden ml-2">
                <button
                  onClick={() => setViewMode("source")}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    viewMode === "source"
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Source
                </button>
                <button
                  onClick={() => setViewMode("preview")}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    viewMode === "preview"
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Preview
                </button>
              </div>
            </div>
          </div>

          {viewMode === "preview" && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 mb-2">
              Preview only &mdash; external resources (CSS, images, scripts) are not included in the proof and will not load.
            </p>
          )}

          {viewMode === "source" ? (
            <pre className="bg-slate-800 text-slate-100 rounded-lg p-4 text-xs overflow-auto max-h-[500px] whitespace-pre-wrap break-all">
              {result.response_body}
            </pre>
          ) : (
            <iframe
              srcDoc={result.response_body!}
              sandbox=""
              className="w-full rounded-lg border border-slate-200 bg-white"
              style={{ height: "500px" }}
              title="Attested page preview"
            />
          )}
        </div>
      )}
    </div>
  );
}
