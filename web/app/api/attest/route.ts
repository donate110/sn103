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

/** Get validator URLs — metagraph discovery (shuffled), with optional fallback. */
async function getValidatorUrls(): Promise<string[]> {
  const envUrl = process.env.VALIDATOR_URL || process.env.NEXT_PUBLIC_VALIDATOR_URL;
  if (envUrl) return [envUrl];
  const fallback = process.env.FALLBACK_VALIDATOR_URL;
  try {
    const urls = await discoverValidatorUrls();
    if (urls.length > 0) {
      const shuffled = shuffle([...urls]);
      if (fallback && !shuffled.includes(fallback)) shuffled.push(fallback);
      return shuffled;
    }
  } catch {
    // fall through
  }
  return fallback ? [fallback] : ["http://localhost:8421"];
}

const DISCOVERY_TIMEOUT_MS = 45_000; // 45s for discovered validators — fast-fail if they can't attest
const FALLBACK_TIMEOUT_MS = 240_000; // 240s for fallback — give it full time for proof generation
const TOTAL_DEADLINE_MS = 270_000; // 4.5 min total — must finish before client's 5 min timeout

/**
 * Translate raw backend errors into helpful human-readable messages.
 * Users see these directly — make them actionable.
 */
function humanizeError(raw: string): string {
  const lower = raw.toLowerCase();

  // Response too large for the configured TLSNotary buffer
  if (lower.includes("more data than was configured") || lower.includes("max_recv")) {
    return "This page is too large to attest (over 2 MB uncompressed). Try attesting a specific article or API endpoint instead of a homepage.";
  }
  // TLS certificate issues
  if (lower.includes("badcertificate") || lower.includes("certificate")) {
    return "Could not verify this site's TLS certificate. The site may use an unusual certificate authority or have an expired certificate.";
  }
  // Connection closed / interrupted
  if (lower.includes("connection closed") || lower.includes("connection reset")) {
    return "The target website closed the connection before the proof could complete. This can happen with sites that block automated requests. Try a different page or URL.";
  }
  // Timeouts
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "The proof took too long to generate. Large or slow-loading pages need more time. Try a smaller page, a specific article URL, or try again in a moment.";
  }
  // Binary not found (miner misconfigured)
  if (lower.includes("binary not found") || lower.includes("binary not available")) {
    return "The attestation service is temporarily misconfigured. This has been logged and the team has been notified. Please try again later.";
  }
  // Server returned non-200 (e.g. 403, 401)
  if (lower.includes("status 403") || lower.includes("forbidden")) {
    return "This website blocked the attestation request (403 Forbidden). Some sites require login or block automated access. Try a publicly accessible page.";
  }
  if (lower.includes("status 401") || lower.includes("unauthorized")) {
    return "This website requires authentication (401 Unauthorized). Only publicly accessible pages can be attested.";
  }
  if (lower.includes("status 404") || lower.includes("not found")) {
    return "The page was not found (404). Double-check the URL and make sure the page exists.";
  }
  // DNS / unreachable
  if (lower.includes("unreachable") || lower.includes("dns") || lower.includes("resolve")) {
    return "Could not reach this website. Check that the URL is correct and the site is online.";
  }
  // Miner internal error / 500
  if (lower.includes("status 500") || lower.includes("internal server error")) {
    return "The attestation miner encountered an internal error. This is usually temporary — please try again.";
  }
  // Miner busy / 503
  if (lower.includes("service shutting down") || lower.includes("503")) {
    return "The attestation service is temporarily busy. Please try again in a minute.";
  }
  // No miners/validators
  if (lower.includes("no reachable miners") || lower.includes("no validators")) {
    return "No attestation services are currently available on the network. Please try again in a few minutes.";
  }
  // Proof verification failed
  if (lower.includes("verification") && lower.includes("failed")) {
    return "The proof was generated but could not be verified. This is unusual — please try again.";
  }
  // Fallback: return the raw error but with a help suffix
  return `${raw}. If this persists, please report it at github.com/djinn-inc/djinn/issues.`;
}

/**
 * POST /api/attest — Proxy attestation requests to validators with fallback.
 *
 * Tries up to 3 randomly-selected validators sequentially. Each attempt has
 * a 240s timeout to accommodate TLSNotary proof generation for large pages.
 *
 * Body: { url: string, request_id: string }
 * Response: AttestResponse from the validator
 */
export async function POST(request: NextRequest) {
  // Tighter rate limit: 5 requests per minute per IP
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

  const sanitizedBody = {
    url: body.url,
    request_id: body.request_id,
  };

  const validators = await getValidatorUrls();
  const attempts = validators.length;
  let lastError = "No attestation services are currently available on the network. Please try again in a few minutes.";
  const startedAt = Date.now();

  for (let i = 0; i < attempts; i++) {
    // Stop if we don't have enough time for a meaningful attempt (at least 30s)
    const elapsed = Date.now() - startedAt;
    const remaining = TOTAL_DEADLINE_MS - elapsed;
    if (remaining < 30_000) break;

    const target = `${validators[i]}/v1/attest`;
    const isFallback = i === validators.length - 1 && !!process.env.FALLBACK_VALIDATOR_URL;
    const perAttemptTimeout = Math.min(isFallback ? FALLBACK_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS, remaining);
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sanitizedBody),
        signal: AbortSignal.timeout(perAttemptTimeout),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.success) {
          // Successful attestation — return immediately
          return NextResponse.json(data);
        }
        // Validator returned 200 but attestation failed — try next validator
        if (data && data.error) {
          lastError = humanizeError(data.error);
        }
        continue;
      }
      // Non-200 = try next validator.
      // 404 = endpoint doesn't exist; 422 = different API schema (non-Djinn validator
      // on the same subnet); 405 = method not allowed. All mean "skip this one".
      if (res.status === 404 || res.status === 422 || res.status === 405) {
        lastError = "This validator doesn't support attestation yet. Trying others...";
      } else {
        lastError = `Attestation service returned an error (${res.status}). Tried ${i + 1} of ${attempts} services.`;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        lastError = "The attestation took too long. Large pages can take up to 3 minutes — try a smaller page, or try again.";
      } else {
        lastError = `Could not reach attestation service (tried ${i + 1} of ${attempts}). The network may be temporarily unavailable.`;
      }
    }
  }

  return NextResponse.json({ error: lastError }, { status: 502 });
}
