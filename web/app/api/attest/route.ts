import { NextRequest, NextResponse } from "next/server";
import { discoverValidatorUrls } from "@/lib/bt-metagraph";
import { getIp, isRateLimited, rateLimitResponse } from "@/lib/rate-limit";

/** Shuffle an array in-place (Fisher-Yates). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Check if a validator has attest_capable=true via its /health endpoint. */
async function checkAttestCapable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.attest_capable;
  } catch {
    return false;
  }
}

/** Get validator URLs — metagraph discovery, sorted by attest capability. */
async function getValidatorUrls(): Promise<string[]> {
  const envUrl = process.env.VALIDATOR_URL || process.env.NEXT_PUBLIC_VALIDATOR_URL;
  if (envUrl) return [envUrl];
  const fallback = process.env.FALLBACK_VALIDATOR_URL;
  try {
    const urls = await discoverValidatorUrls();
    if (urls.length > 0) {
      const shuffled = shuffle([...urls]);

      // Quick health check to find attest-capable validators (3s timeout per check, all in parallel)
      const checks = await Promise.allSettled(
        shuffled.map(async (url) => ({ url, capable: await checkAttestCapable(url) })),
      );

      const capable: string[] = [];
      const rest: string[] = [];
      for (const result of checks) {
        if (result.status === "fulfilled") {
          if (result.value.capable) capable.push(result.value.url);
          else rest.push(result.value.url);
        }
      }

      // Attest-capable validators first, then the rest
      const sorted = [...capable, ...rest];
      if (fallback && !sorted.includes(fallback)) sorted.push(fallback);
      return sorted;
    }
  } catch {
    // fall through
  }
  return fallback ? [fallback] : ["http://localhost:8421"];
}

const PER_VALIDATOR_TIMEOUT_MS = 120_000;
const TOTAL_DEADLINE_MS = 180_000; // 3 min total

/**
 * Translate raw backend errors into helpful human-readable messages.
 */
function humanizeError(raw: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("more data than was configured") || lower.includes("max_recv")) {
    return "This page is too large to attest (over 2 MB uncompressed). Try attesting a specific article or API endpoint instead of a homepage.";
  }
  if (lower.includes("badcertificate") || lower.includes("certificate")) {
    return "Could not verify this site's TLS certificate. The site may use an unusual certificate authority or have an expired certificate.";
  }
  if (lower.includes("connection closed") || lower.includes("connection reset")) {
    return "The target website closed the connection before the proof could complete. This can happen with sites that block automated requests. Try a different page or URL.";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "The proof took too long to generate. Large or slow-loading pages need more time. Try a smaller page, a specific article URL, or try again in a moment.";
  }
  if (lower.includes("binary not found") || lower.includes("binary not available")) {
    return "The attestation service is temporarily misconfigured. This has been logged and the team has been notified. Please try again later.";
  }
  if (lower.includes("status 403") || lower.includes("forbidden")) {
    return "This website blocked the attestation request (403 Forbidden). Some sites require login or block automated access. Try a publicly accessible page.";
  }
  if (lower.includes("status 401") || lower.includes("unauthorized")) {
    return "This website requires authentication (401 Unauthorized). Only publicly accessible pages can be attested.";
  }
  if (lower.includes("status 404") || lower.includes("not found")) {
    return "The page was not found (404). Double-check the URL and make sure the page exists.";
  }
  if (lower.includes("unreachable") || lower.includes("dns") || lower.includes("resolve")) {
    return "Could not reach this website. Check that the URL is correct and the site is online.";
  }
  if (lower.includes("status 500") || lower.includes("internal server error")) {
    return "The attestation miner encountered an internal error. This is usually temporary — please try again.";
  }
  if (lower.includes("service shutting down") || lower.includes("503")) {
    return "The attestation service is temporarily busy. Please try again in a minute.";
  }
  if (lower.includes("at capacity")) {
    return "The attestation network is busy right now. Please wait about 30 seconds and try again.";
  }
  if (lower.includes("no reachable miners") || lower.includes("no validators")) {
    return "No attestation services are currently available on the network. Please try again in a few minutes.";
  }
  if (lower.includes("verification") && lower.includes("failed")) {
    return "The proof was generated but could not be verified. This is unusual — please try again.";
  }
  return `${raw}. If this persists, please report it at github.com/djinn-inc/djinn/issues.`;
}

/**
 * Try one validator. Returns the JSON response on success, null on failure.
 */
async function tryValidator(
  target: string,
  body: string,
  timeoutMs: number,
): Promise<{ data: Record<string, unknown>; error?: never } | { data?: never; error: string }> {
  try {
    const res = await fetch(`${target}/v1/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 422 || res.status === 405) {
        return { error: "Validator doesn't support attestation" };
      }
      return { error: `Validator returned ${res.status}` };
    }
    const data = await res.json();
    if (data && data.busy) {
      return { error: "Validator busy" };
    }
    if (data && data.success) {
      return { data };
    }
    return { error: data?.error || "Attestation failed" };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { error: "Timeout" };
    }
    return { error: String(err) };
  }
}

/**
 * POST /api/attest — Proxy attestation requests to validators.
 *
 * Tries up to 3 validators in parallel (race), takes the first success.
 * Validators are sorted by attest_capable health flag.
 *
 * Body: { url: string, request_id: string }
 * Response: AttestResponse from the validator
 */
export async function POST(request: NextRequest) {
  if (isRateLimited("attest", getIp(request), 5)) {
    return rateLimitResponse();
  }

  let body: { url?: string; request_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Could not parse the request. Make sure you're sending valid JSON with a \"url\" field." },
      { status: 400 },
    );
  }

  // Server-side validation
  if (!body.url || typeof body.url !== "string" || !body.url.startsWith("https://") || body.url.length > 2048) {
    return NextResponse.json(
      { error: "Please enter a valid HTTPS URL (must start with https:// and be under 2048 characters)." },
      { status: 400 },
    );
  }
  // Block SSRF to private/internal addresses
  try {
    const parsed = new URL(body.url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)
    ) {
      return NextResponse.json(
        { error: "Only public websites can be attested. Internal or private network URLs are not supported." },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "This doesn't look like a valid URL. Please check the format and try again." },
      { status: 400 },
    );
  }
  if (!body.request_id || typeof body.request_id !== "string" || body.request_id.length > 256) {
    return NextResponse.json(
      { error: "A request_id is required (max 256 characters)." },
      { status: 400 },
    );
  }

  const sanitizedBody = JSON.stringify({
    url: body.url,
    request_id: body.request_id,
  });

  const validators = await getValidatorUrls();
  const startedAt = Date.now();

  // Wave 1: Try first 3 validators in parallel (these should be attest-capable)
  // Wave 2: If wave 1 all fail, try next 3, etc.
  const WAVE_SIZE = 3;
  let lastError = "No attestation services are currently available on the network. Please try again in a few minutes.";

  for (let wave = 0; wave * WAVE_SIZE < validators.length; wave++) {
    const elapsed = Date.now() - startedAt;
    const remaining = TOTAL_DEADLINE_MS - elapsed;
    if (remaining < 10_000) break;

    const batch = validators.slice(wave * WAVE_SIZE, (wave + 1) * WAVE_SIZE);
    if (batch.length === 0) break;

    const timeoutMs = Math.min(PER_VALIDATOR_TIMEOUT_MS, remaining);

    // Race all validators in this wave — first success wins
    const results = await Promise.allSettled(
      batch.map((url) => tryValidator(url, sanitizedBody, timeoutMs)),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.data) {
        return NextResponse.json(result.value.data);
      }
    }

    // Collect errors for reporting
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.error) {
        lastError = result.value.error;
      }
    }
  }

  return NextResponse.json(
    { error: humanizeError(lastError) },
    { status: 502 },
  );
}
