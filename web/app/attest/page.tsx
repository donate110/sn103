"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AttestResult {
  request_id: string;
  url: string;
  success: boolean;
  verified: boolean;
  /** Who performed verification: validator (server-side) or client (browser WASM) */
  verifiedBy?: "validator" | "client" | null;
  /** True if the site served a bot challenge/wall instead of actual content */
  blocked?: boolean;
  proof_hex: string | null;
  response_body: string | null;
  server_name: string | null;
  timestamp: number;
  error: string | null;
  /** Timing metadata (client-side wall clock) */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

type Status = "idle" | "proving" | "verifying" | "done" | "error";

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
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<AttestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showApi, setShowApi] = useState(false);
  const elapsed = useElapsedTimer(status === "proving" || status === "verifying");

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!url.startsWith("https://")) {
        setErrorMsg("URL must start with https://");
        return;
      }

      setStatus("proving");
      setResult(null);
      setErrorMsg(null);

      const t0 = Date.now();

      try {
        const requestId = `attest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const resp = await fetch("/api/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, request_id: requestId }),
          signal: AbortSignal.timeout(300_000), // 5 min client-side timeout
        });

        if (!resp.ok) {
          const data = await resp.json().catch(() => ({ detail: "Request failed" }));
          throw new Error(data.detail || data.error || `Request failed (${resp.status})`);
        }

        const data = await resp.json();

        // Track who verified the proof
        if (data.verified) {
          data.verifiedBy = "validator";
        }

        // If proof exists but validator didn't verify, try client-side WASM verification
        if (data.success && !data.verified && data.proof_hex) {
          setResult(data);
          setStatus("verifying");
          try {
            const { verifyProof } = await import("@/lib/wasm/verify");
            const verifyResult = await verifyProof(data.proof_hex);
            if (verifyResult.status === "verified") {
              // Check server_name matches requested URL (accounting for redirects)
              const requestedHost = new URL(data.url || url).hostname;
              const proofServer = verifyResult.server_name || data.server_name || "";
              const serverOk =
                !proofServer ||
                proofServer === requestedHost ||
                requestedHost.endsWith("." + proofServer) ||
                proofServer.endsWith("." + requestedHost);
              data.verified = serverOk;
              if (serverOk) {
                data.verifiedBy = "client";
              }
              if (!serverOk) {
                data.error = `server mismatch: expected ${requestedHost}, got ${proofServer}`;
              }
              // Fill in server_name and response_body from WASM verification
              if (verifyResult.server_name && !data.server_name) {
                data.server_name = verifyResult.server_name;
              }
              if (!data.response_body && verifyResult.response_body) {
                data.response_body = verifyResult.response_body;
              }
            }
          } catch {
            // WASM verification failed — show result as-is
          }
        }

        // Attach timing metadata
        const t1 = Date.now();
        data.startedAt = t0;
        data.finishedAt = t1;
        data.durationMs = t1 - t0;

        setResult(data);
        setStatus("done");
        if (data && !data.success) {
          setErrorMsg(data.error || "Attestation failed");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "TimeoutError") {
          setErrorMsg("The request timed out after 5 minutes. Try a smaller page or try again later.");
        } else {
          setErrorMsg(err instanceof Error ? err.message : "Network error");
        }
        setStatus("error");
      }
    },
    [url],
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
              <strong>Enter a URL.</strong> Paste any public HTTPS URL you want to prove.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-xs font-bold">2</span>
            <span>
              <strong>Wait for the proof.</strong> A miner on Bittensor Subnet 103 generates a TLSNotary proof. Simple pages take 30 seconds; large pages can take up to 3 minutes.
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

      {/* Form */}
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <form onSubmit={handleSubmit}>
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
            disabled={status === "proving" || status === "verifying"}
          />
          <p className="text-xs text-slate-400 mt-1">Must be a public HTTPS URL. Smaller pages (articles, API endpoints) work best. Very large pages (homepages, feeds) may time out.</p>

          <button
            type="submit"
            className="mt-4 w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={status === "proving" || status === "verifying" || !url}
          >
            {status === "proving" || status === "verifying" ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {status === "verifying" ? "Verifying proof..." : "Generating proof..."}{" "}
                {elapsed > 0 && <span className="tabular-nums">{elapsed}s</span>}
              </>
            ) : (
              "Attest"
            )}
          </button>
        </form>
      </div>

      {/* Input disabled overlay */}
      {status === "verifying" && (
        <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-700">
          Verifying proof in your browser...
        </div>
      )}

      {/* Error message */}
      {errorMsg && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p>{errorMsg}</p>
          {!errorMsg.includes("github.com") && (
            <p className="mt-2 text-xs text-red-500">
              Persistent issues?{" "}
              <a
                href="https://github.com/djinn-inc/djinn/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-red-700"
              >
                Report it on GitHub
              </a>
            </p>
          )}
        </div>
      )}

      {/* Result */}
      {result && result.success && (
        <ResultCard result={result} onDownload={handleDownload} />
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
                <code className="bg-slate-100 px-1 rounded">response_body</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">verified</code>,{" "}
                <code className="bg-slate-100 px-1 rounded">server_name</code>, and{" "}
                <code className="bg-slate-100 px-1 rounded">timestamp</code>.
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
        <h3 className="font-semibold text-slate-700 pt-4">Why Djinn attestations are different</h3>
        <p>
          Most TLSNotary services are centralized, so you have to trust the operator&apos;s notary
          server not to collude or fabricate proofs. Djinn aims to reduce that trust assumption.
          Bittensor Subnet 103 validators randomly select two miners on different IP addresses for
          each attestation: one acts as the prover, the other as the notary. Neither knows in advance
          they&apos;ll be paired, and neither can influence the assignment. The result is a
          cryptographic proof with no single point of trust.
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
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium cursor-default ${
            result.verified
              ? "bg-green-100 text-green-700 border border-green-200"
              : "bg-amber-100 text-amber-700 border border-amber-200"
          }`}
          title={
            result.verified
              ? result.verifiedBy === "client"
                ? "Proof is valid and was verified client-side (browser WASM)"
                : "Proof verified by validator (server-side)"
              : "Proof was not verified"
          }
        >
          {result.verified ? "Verified" : "Unverified"}
        </span>
        {result.blocked && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium cursor-default bg-orange-100 text-orange-700 border border-orange-200"
            title="The website served a bot protection page instead of actual content. The proof is cryptographically valid but may not contain the content you expected."
          >
            Bot Protected
          </span>
        )}
        <h2 className="text-lg font-semibold text-slate-900">Attestation Result</h2>
      </div>

      {result.blocked && (
        <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-700">
          This website served a bot protection page (e.g. Cloudflare challenge) instead of the actual content.
          The proof is cryptographically valid but contains the challenge page, not the real page content.
          Try a different URL or a page that doesn&apos;t require browser JavaScript to load.
        </div>
      )}

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
        {result.durationMs != null && (
          <div>
            <dt className="text-slate-500">Timing</dt>
            <dd className="text-slate-900 text-xs font-mono tabular-nums">
              {new Date(result.startedAt!).toLocaleTimeString()} &rarr;{" "}
              {new Date(result.finishedAt!).toLocaleTimeString()}{" "}
              <span className="text-slate-500">
                ({(result.durationMs / 1000).toFixed(1)}s)
              </span>
            </dd>
          </div>
        )}
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
              Preview only. External resources (CSS, images, scripts) are not included in the proof and will not load.
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
