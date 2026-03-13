/**
 * Typed HTTP clients for the Djinn validator and miner REST APIs.
 */

// ---------------------------------------------------------------------------
// Request / Response types (mirrors Pydantic models)
// ---------------------------------------------------------------------------

export interface StoreShareRequest {
  signal_id: string;
  genius_address: string;
  share_x: number;
  share_y: string; // Hex-encoded field element
  encrypted_key_share: string; // Hex-encoded
  encrypted_index_share: string; // Hex-encoded Shamir share of real index (for MPC)
  shamir_threshold: number; // Declared Shamir reconstruction threshold
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
    return post<PurchaseResponse>(
      `${this.baseUrl}/v1/signal/${encodeURIComponent(signalId)}/purchase`,
      req,
    );
  }

  async checkLines(req: CheckRequest): Promise<CheckResponse> {
    return post<CheckResponse>(`${this.baseUrl}/v1/check`, req);
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
export async function discoverValidatorClients(): Promise<ValidatorClient[]> {
  if (typeof window === "undefined") {
    // Server-side: use direct URLs from env or metagraph
    return getValidatorUrls().map((url) => new ValidatorClient(url.trim()));
  }

  // Browser: call the discovery endpoint and create per-UID proxy clients
  try {
    const res = await fetch("/api/validators/discover");
    if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
    const { validators } = await res.json() as { validators: { uid: number }[] };
    if (validators.length === 0) throw new Error("No validators discovered");
    return validators.map((v) => new ValidatorClient(`/api/validators/${v.uid}`));
  } catch {
    // Fallback to single proxy
    return [new ValidatorClient("/api/validator")];
  }
}

export function getValidatorClients(): ValidatorClient[] {
  return getValidatorUrls().map((url) => new ValidatorClient(url.trim()));
}

export function getValidatorClient(): ValidatorClient {
  return new ValidatorClient(getValidatorUrls()[0].trim());
}

export function getMinerClient(): MinerClient {
  return new MinerClient(getMinerUrl());
}

/**
 * Resilient line check that queries multiple validators in parallel and
 * merges results.
 *
 * Each validator proxies to a random miner. ~50% of miners in the network
 * have broken Odds API data, returning 0 available lines for valid games.
 * Even working miners may report different subsets of lines as available.
 *
 * Strategy: fire parallel checks through ALL discovered validators
 * (most miners have broken Odds API keys, so we need maximum coverage).
 * Merge the union of all available_indices. For each index, use the
 * richest bookmaker data from any response. This maximizes the chance
 * that the real pick (unknown to the client) is in the available set
 * for the MPC check.
 */
export async function resilientCheckLines(
  req: CheckRequest,
): Promise<CheckResponse> {
  let validators: ValidatorClient[];
  try {
    validators = await discoverValidatorClients();
  } catch {
    validators = [getValidatorClient()];
  }

  // Shuffle to spread load, then check ALL validators in parallel.
  // Most miners (~7/8) have broken Odds API keys, so checking only 4
  // has a ~50% chance of missing the one working miner.
  for (let i = validators.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [validators[i], validators[j]] = [validators[j], validators[i]];
  }

  // Fire parallel checks through ALL validators (lightweight endpoint)
  const settled = await Promise.allSettled(
    validators.map((v) => v.checkLines(req)),
  );

  // Collect all successful responses
  const responses: CheckResponse[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && !r.value.api_error) {
      responses.push(r.value);
    }
  }

  // If all parallel checks failed, try sequential retries on each
  if (responses.length === 0) {
    for (let attempt = 0; attempt < validators.length; attempt++) {
      const v = validators[attempt];
      try {
        const result = await v.checkLines(req);
        if (!result.api_error) responses.push(result);
        if (result.available_indices.length > 0) break;
      } catch {
        // Try next
      }
    }
  }

  if (responses.length === 0) {
    return {
      results: req.lines.map((l) => ({
        index: l.index,
        available: false,
        bookmakers: [],
      })),
      available_indices: [],
      response_time_ms: 0,
      api_error: "All validators/miners unreachable",
    };
  }

  // Merge: for each line index, take the union of availability.
  // If ANY miner says a line is available, it's available.
  const mergedResults: Map<number, LineResult> = new Map();
  for (const resp of responses) {
    for (const lr of resp.results) {
      const existing = mergedResults.get(lr.index);
      if (!existing) {
        mergedResults.set(lr.index, { ...lr, bookmakers: [...lr.bookmakers] });
      } else if (lr.available && !existing.available) {
        // Upgrade: this miner says available, use its data
        mergedResults.set(lr.index, { ...lr, bookmakers: [...lr.bookmakers] });
      } else if (lr.available && existing.available && lr.bookmakers.length > existing.bookmakers.length) {
        // Both available, but this one has richer bookmaker data
        mergedResults.set(lr.index, { ...lr, bookmakers: [...lr.bookmakers] });
      }
    }
  }

  const mergedArray = req.lines.map((l) =>
    mergedResults.get(l.index) ?? { index: l.index, available: false, bookmakers: [] },
  );
  let mergedIndices = mergedArray.filter((r) => r.available).map((r) => r.index);

  // Fallback: when all miners report 0 available lines (common when miners
  // have exhausted their Odds API quotas), check against the platform's own
  // API key via the server-side /api/check-lines endpoint.
  if (mergedIndices.length === 0 && responses.length > 0) {
    console.log("[resilientCheckLines] all miners returned 0 available, trying platform fallback");
    try {
      const fallbackResp = await fetch("/api/check-lines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: req.lines }),
      });
      if (fallbackResp.ok) {
        const fallback: CheckResponse = await fallbackResp.json();
        if (fallback.available_indices.length > 0) {
          console.log("[resilientCheckLines] platform fallback found", fallback.available_indices.length, "available lines");
          return fallback;
        }
      }
    } catch (e) {
      console.log("[resilientCheckLines] platform fallback failed:", String(e).slice(0, 200));
    }
  }

  return {
    results: mergedArray,
    available_indices: mergedIndices,
    response_time_ms: Math.max(...responses.map((r) => r.response_time_ms)),
  };
}
