/**
 * Browser-side TLSNotary proof verification using WASM.
 *
 * Loads the WASM verifier module lazily on first use and provides a
 * simple `verifyProof()` function that takes proof bytes (hex string)
 * and returns a structured result.
 */

let wasmModule: typeof import("./djinn_tlsn_verify_wasm") | null = null;
let initPromise: Promise<void> | null = null;

interface VerifyResult {
  status: "verified" | "failed";
  server_name?: string;
  notary_key?: string;
  timestamp?: number;
  response_body?: string;
  error?: string;
}

async function ensureLoaded(): Promise<typeof import("./djinn_tlsn_verify_wasm")> {
  if (wasmModule) return wasmModule;
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("./djinn_tlsn_verify_wasm");
      await mod.default("/djinn_tlsn_verify_wasm_bg.wasm");
      wasmModule = mod;
    })();
  }
  await initPromise;
  return wasmModule!;
}

/**
 * Verify a TLSNotary proof in the browser.
 *
 * @param proofHex - The proof as a hex string (from the API response's proof_hex field)
 * @returns Verification result with status, server name, response body, etc.
 */
export async function verifyProof(proofHex: string): Promise<VerifyResult> {
  try {
    const mod = await ensureLoaded();
    // Convert hex string to Uint8Array
    const bytes = new Uint8Array(
      proofHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );
    const resultJson = mod.verify_proof(bytes);
    return JSON.parse(resultJson) as VerifyResult;
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : "WASM verification failed",
    };
  }
}
