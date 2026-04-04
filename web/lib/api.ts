/**
 * Typed HTTP clients for the Djinn validator and miner REST APIs.
 */

// ---------------------------------------------------------------------------
// Request / Response types (mirrors Pydantic models)
// ---------------------------------------------------------------------------

export interface BeaverTripleData {
  a: string; // Hex-encoded field element
  b: string;
  c: string; // c = a * b mod p
}

export interface StoreShareRequest {
  signal_id: string;
  genius_address: string;
  share_x: number;
  share_y: string; // Hex-encoded field element
  encrypted_key_share: string; // Hex-encoded
  encrypted_index_share: string; // Hex-encoded Shamir share of real index (for MPC)
  shamir_threshold: number; // Declared Shamir reconstruction threshold
  precomputed_triples?: BeaverTripleData[]; // Pre-computed Beaver triples for fast MPC
}

export interface StoreShareResponse {
  signal_id: string;
  stored: boolean;
}

export interface PurchaseRequest {
  buyer_address: string;
  sportsbook: string;
  available_indices: number[];
  buyer_signature?: string;
}

export interface ShareInfoResponse {
  signal_id: string;
  share_x: number;
  shamir_threshold: number;
}

export interface PurchaseResponse {
  signal_id: string;
  status: string;
  available: boolean | null;
  encrypted_key_share: string | null; // Hex-encoded Shamir share y-value
  share_x: number | null; // Shamir share x-coordinate
  message: string;
}

export interface ValidatorHealthResponse {
  status: string;
  version: string;
  uid: number | null;
  shares_held: number;
  chain_connected: boolean;
  bt_connected: boolean;
}

export interface CandidateLine {
  index: number;
  sport: string;
  event_id: string;
  home_team: string;
  away_team: string;
  market: string;
  line: number | null;
  side: string;
}

export interface CheckRequest {
  lines: CandidateLine[];
}

export interface BookmakerAvailability {
  bookmaker: string;
  odds: number;
}

export interface LineResult {
  index: number;
  available: boolean;
  bookmakers: BookmakerAvailability[];
  unavailable_reason?: string | null;
}

export interface CheckResponse {
  results: LineResult[];
  available_indices: number[];
  response_time_ms: number;
  api_error?: string | null;
}

export interface MinerHealthResponse {
  status: string;
  version: string;
  uid: number | null;
  odds_api_connected: boolean;
  bt_connected: boolean;
  uptime_seconds: number;
}

// ---------------------------------------------------------------------------
// HTTP client helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 500;

/** Error subclass for API errors with status code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly url: string,
  ) {
    super(`${status}: ${detail}`);
    this.name = "ApiError";
  }

  /** True if the error is retryable (5xx or network failure). */
  get retryable(): boolean {
    return this.status >= 500;
  }

  /** True if rate-limited. */
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** Check if an error is retryable (5xx, network, or timeout). */
function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.retryable;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  if (err instanceof TypeError) return true; // network errors
  return false;
}

/** Sleep for ms with optional jitter. */
function sleep(ms: number): Promise<void> {
  const jitter = ms * 0.2 * Math.random();
  return new Promise((resolve) => setTimeout(resolve, ms + jitter));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries = MAX_RETRIES,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok || res.status < 500) return res;
      // 5xx — retryable
      lastErr = new ApiError(
        res.status,
        await res.text().catch(() => res.statusText),
        url,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        lastErr = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
        // Timeouts are not retried
        throw lastErr;
      }
      lastErr = err;
      if (!isRetryable(err)) throw err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await sleep(RETRY_BACKOFF_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function post<T>(url: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, detail, url);
  }
  return res.json() as Promise<T>;
}

async function get<T>(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const res = await fetchWithRetry(url, {}, timeoutMs);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, detail, url);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// ValidatorClient
// ---------------------------------------------------------------------------

const SIGNAL_ID_RE = /^[a-zA-Z0-9_\-]{1,256}$/;

export class ValidatorClient {
  constructor(public readonly baseUrl: string) {}

  async storeShare(req: StoreShareRequest): Promise<StoreShareResponse> {
    return post<StoreShareResponse>(`${this.baseUrl}/v1/signal`, req);
  }

  async purchaseSignal(
    signalId: string,
    req: PurchaseRequest,
  ): Promise<PurchaseResponse> {
    if (!SIGNAL_ID_RE.test(signalId)) {
      throw new Error("Invalid signal ID format");
    }
    // MPC computation takes 30-45s on the current network. Use 60s timeout
    // (default 30s is too short and causes every purchase to fail).
    return post<PurchaseResponse>(
      `${this.baseUrl}/v1/signal/${encodeURIComponent(signalId)}/purchase`,
      req,
      60_000,
    );
  }

  async checkLines(req: CheckRequest): Promise<CheckResponse> {
    return post<CheckResponse>(`${this.baseUrl}/v1/check`, req);
  }

  async shareInfo(signalId: string): Promise<ShareInfoResponse> {
    if (!SIGNAL_ID_RE.test(signalId)) {
      throw new Error("Invalid signal ID format");
    }
    return get<ShareInfoResponse>(
      `${this.baseUrl}/v1/signal/${encodeURIComponent(signalId)}/share_info`,
    );
  }

  async health(): Promise<ValidatorHealthResponse> {
    return get<ValidatorHealthResponse>(`${this.baseUrl}/health`);
  }
}

// ---------------------------------------------------------------------------
// MinerClient
// ---------------------------------------------------------------------------

export class MinerClient {
  constructor(private baseUrl: string) {}

  async checkLines(req: CheckRequest): Promise<CheckResponse> {
    return post<CheckResponse>(`${this.baseUrl}/v1/check`, req);
  }

  async health(): Promise<MinerHealthResponse> {
    return get<MinerHealthResponse>(`${this.baseUrl}/health`);
  }
}

// ---------------------------------------------------------------------------
// Singleton instances (configured from env vars)
// ---------------------------------------------------------------------------

function getEnvOrDefault(envVar: string, devDefault: string): string {
  const val = process.env[envVar];
  if (val) return val;
  return devDefault;
}

function getValidatorUrls(): string[] {
  // In the browser, route through the Next.js API proxy so the actual
  // validator URL is resolved server-side at runtime (not baked at build time).
  if (typeof window !== "undefined") return ["/api/validator"];
  return getEnvOrDefault(
    "VALIDATOR_URL",
    getEnvOrDefault("NEXT_PUBLIC_VALIDATOR_URL", "http://localhost:8421"),
  ).split(",").filter((u) => u.trim().length > 0);
}

function getMinerUrl(): string {
  if (typeof window !== "undefined") return "/api/miner";
  return getEnvOrDefault(
    "MINER_URL",
    getEnvOrDefault("NEXT_PUBLIC_MINER_URL", "http://localhost:8422"),
  );
}

/**
 * Discover all validators from the metagraph and return per-validator clients.
 * Each client routes through a UID-specific proxy: /api/validators/{uid}/...
 * This ensures Shamir shares go to different validators.
 */
// Cache validator discovery for 30 seconds to avoid redundant network calls
// during multi-step flows (purchase, signal creation)
let _discoveryCache: { clients: ValidatorClient[]; ts: number } | null = null;
const DISCOVERY_CACHE_MS = 30_000;

export async function discoverValidatorClients(): Promise<ValidatorClient[]> {
  if (typeof window === "undefined") {
    return getValidatorUrls().map((url) => new ValidatorClient(url.trim()));
  }

  // Return cached result if fresh
  if (_discoveryCache && Date.now() - _discoveryCache.ts < DISCOVERY_CACHE_MS) {
    return _discoveryCache.clients;
  }

  try {
    const res = await fetch("/api/validators/discover");
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    const { validators } = await res.json() as { validators: { uid: number; ip?: string; port?: number }[] };
    if (validators.length === 0) throw new Error("No validators discovered");
    // Always use the Next.js API proxy for browser connections.
    // Direct IP connections are blocked by CSP (mixed content, raw HTTP on HTTPS page).
    const clients = validators.map((v) => {
      return new ValidatorClient(`/api/validators/${v.uid}`);
    });
    _discoveryCache = { clients, ts: Date.now() };
    return clients;
  } catch {
    return [new ValidatorClient("/api/validator")];
  }
}

function getValidatorClient(): ValidatorClient {
  return new ValidatorClient(getValidatorUrls()[0].trim());
}

/**
 * Resilient line check that queries validators in parallel.
 *
 * Each validator fans out to up to 15 miners in parallel and merges
 * results (union of available_indices). The client queries multiple
 * validators for redundancy and merges across validators too.
 *
/**
 * Check line availability exclusively through the decentralized miner network.
 * Used for purchase verification where the result must come from the subnet,
 * not the platform's own Odds API.
 */
export async function checkLinesViaSubnet(
  req: CheckRequest,
): Promise<CheckResponse> {
  const result = await _checkViaMinerNetwork(req);
  if (result) return result;

  return {
    results: req.lines.map((l) => ({
      index: l.index,
      available: false,
      bookmakers: [],
    })),
    available_indices: [],
    response_time_ms: 0,
    api_error: "No miners could verify line availability. The miner network may be temporarily down.",
  };
}

/** Internal: query validators/miners for line check data.
 * Returns as soon as ANY validator provides available lines,
 * rather than waiting for all validators to respond.
 */
async function _checkViaMinerNetwork(req: CheckRequest): Promise<CheckResponse | null> {
  let validators: ValidatorClient[];
  try {
    validators = await discoverValidatorClients();
  } catch {
    validators = [getValidatorClient()];
  }

  // Race: return as soon as any validator finds available lines.
  // Don't wait for broken validators (502/503) to time out.
  const result = await Promise.any(
    validators.map((v) =>
      v.checkLines(req).then((r) => {
        if (r.api_error || r.available_indices.length === 0) {
          throw new Error("no results from this validator");
        }
        console.log("[checkLines] Miner network responded:", r.available_indices.length, "lines available");
        return r;
      }),
    ),
  ).catch(() => null);

  return result;
}
