"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AttestResult {
  request_id: string;
  url: string;
  success: boolean;
  verified: boolean;
  proof_hex: string | null;
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

const BURN_ADDRESS = "5GrsjiBeCErhUGj339vu5GubTgyJMyZLGQqUFBJAtKrCziU9";
const COST_PER_ATTEST = 0.0001;

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
  const [burnTxHash, setBurnTxHash] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<AttestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const elapsed = useElapsedTimer(status === "proving");

  // Check burn credits when tx hash changes (debounced)
  useEffect(() => {
    const hash = burnTxHash.trim();
    if (!hash || hash.length < 8) {
      setCredits(null);
      return;
    }
    setCreditsLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const resp = await fetch("/api/attest/credits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ burn_tx_hash: hash }),
          signal: controller.signal,
        });
        if (resp.ok) {
          const data = await resp.json();
          setCredits(data.remaining ?? null);
        } else {
          setCredits(null);
        }
      } catch {
        // Ignore fetch errors (abort, network)
      } finally {
        setCreditsLoading(false);
      }
    }, 600);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [burnTxHash]);

  const copyBurnAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(BURN_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = BURN_ADDRESS;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, []);

  const attestSingle = useCallback(
    async (targetUrl: string, txHash: string): Promise<AttestResult | null> => {
      const requestId = `attest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resp = await fetch("/api/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          request_id: requestId,
          burn_tx_hash: txHash.trim(),
        }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ detail: "Request failed" }));
        const msg = data.detail || data.error || `Request failed (${resp.status})`;
        throw new Error(
          resp.status === 403 ? `Burn verification failed: ${msg}` : msg,
        );
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
      if (!burnTxHash.trim()) {
        setErrorMsg("Burn transaction hash is required");
        return;
      }

      setStatus("proving");
      setResult(null);
      setErrorMsg(null);

      try {
        const data = await attestSingle(url, burnTxHash);
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
    [url, burnTxHash, attestSingle],
  );

  const handleBatchSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!burnTxHash.trim()) {
        setErrorMsg("Burn transaction hash is required");
        return;
      }

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
          const data = await attestSingle(items[i].url, burnTxHash);
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
    [batchUrls, burnTxHash, attestSingle],
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
  const batchCost = (parsedBatchCount * COST_PER_ATTEST).toFixed(4);

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Web Attestation</h1>
        <p className="text-slate-500 mt-1">
          Generate cryptographic TLSNotary proofs that websites served specific content at a
          specific time. Powered by Bittensor Subnet 103.
        </p>
      </div>

      {/* Step-by-step instructions */}
      <div className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">How it works</h2>
        <ol className="space-y-3 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">1</span>
            <span>
              <strong>Burn alpha tokens.</strong> Transfer <strong>{COST_PER_ATTEST} TAO</strong> per page to the burn address below from your Bittensor wallet.
              For multiple pages, send a single larger transfer (e.g., 0.0013 TAO for 13 pages).
              <strong className="text-amber-600"> Burns must be recent — within the last 300 blocks (~50 minutes).</strong>
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">2</span>
            <span>
              <strong>Copy the extrinsic hash.</strong> After your burn transfer confirms, copy the substrate extrinsic hash from your wallet or a block explorer.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">3</span>
            <span>
              <strong>Submit your URL(s).</strong> Paste the burn tx hash and the URL(s) you want to attest. A miner will generate a TLSNotary proof (30-90 seconds per page).
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">4</span>
            <span>
              <strong>Download your proof.</strong> The validator verifies the proof and returns it. Download the cryptographic proof file.
            </span>
          </li>
        </ol>

        <div className="mt-4 rounded-md bg-slate-50 border border-slate-200 p-3">
          <p className="text-xs font-medium text-slate-500 mb-1">Burn address (SN103 alpha)</p>
          <div className="flex items-center gap-2">
            <p className="font-mono text-xs break-all text-slate-800 flex-1 select-all">{BURN_ADDRESS}</p>
            <button
              type="button"
              onClick={copyBurnAddress}
              className="flex-shrink-0 rounded-md px-2 py-1 text-xs font-medium border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
              aria-label="Copy burn address"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Don&apos;t have alpha?{" "}
          <a
            href="https://docs.bittensor.com/subnets/register-validate-mine"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-slate-600"
          >
            Stake TAO on Subnet 103
          </a>{" "}
          to acquire alpha tokens. The burn is approximately $0.02 per attestation.
        </p>
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
          {/* Burn tx hash — shared between modes */}
          <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="burn-tx-hash">
            Burn transaction hash
          </label>
          <input
            id="burn-tx-hash"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-slate-500 focus:border-slate-500"
            type="text"
            placeholder="0x..."
            value={burnTxHash}
            onChange={(e) => setBurnTxHash(e.target.value)}
            required
            disabled={status === "proving" || batchRunning}
          />
          <div className="flex items-center gap-2 mt-1 mb-4">
            <p className="text-xs text-slate-400 flex-1">
              The substrate extrinsic hash from your alpha burn transfer. One burn can cover multiple attestations.
            </p>
            {creditsLoading && (
              <span className="text-xs text-slate-400 flex-shrink-0">Checking...</span>
            )}
            {!creditsLoading && credits !== null && (
              <span className={`text-xs font-medium flex-shrink-0 ${credits > 0 ? "text-green-600" : "text-red-500"}`}>
                {credits > 0 ? `${credits} credit${credits !== 1 ? "s" : ""} remaining` : "No credits remaining"}
              </span>
            )}
          </div>

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
                  {parsedBatchCount} URL{parsedBatchCount !== 1 ? "s" : ""} — burn cost: <strong>{batchCost} TAO</strong>
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
              !burnTxHash ||
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
    "request_id": "my-unique-id",
    "burn_tx_hash": "0x..."
  }'`}</pre>
              <p className="text-xs text-slate-400 mt-1">
                Response includes <code className="bg-slate-100 px-1 rounded">proof_hex</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">verified</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">server_name</code>, and{" "}
                <code className="bg-slate-100 px-1 rounded">timestamp</code>.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-800 mb-1">POST /api/attest/credits</h4>
              <p className="text-slate-500 mb-2">Check remaining credits for a burn transaction.</p>
              <pre className="bg-slate-800 text-slate-100 rounded-lg p-3 text-xs overflow-x-auto">{`curl -X POST https://djinn.gg/api/attest/credits \\
  -H "Content-Type: application/json" \\
  -d '{ "burn_tx_hash": "0x..." }'`}</pre>
              <p className="text-xs text-slate-400 mt-1">
                Returns <code className="bg-slate-100 px-1 rounded">{`{ "remaining": 12 }`}</code>
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-slate-800 mb-1">Bulk attestation</h4>
              <p className="text-slate-500">
                To attest multiple pages, burn <strong>N &times; {COST_PER_ATTEST} TAO</strong> in a single
                transfer, then call <code className="bg-slate-100 px-1 rounded">POST /api/attest</code> once
                per URL using the same <code className="bg-slate-100 px-1 rounded">burn_tx_hash</code>. Each
                call consumes one credit.
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
  const proofFingerprint =
    result.proof_hex && result.proof_hex.length >= 2
      ? result.proof_hex.slice(0, 32)
      : null;

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

      {result.proof_hex && (
        <button
          onClick={() => onDownload(result.proof_hex!, result.timestamp)}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          Download proof
        </button>
      )}
    </div>
  );
}
