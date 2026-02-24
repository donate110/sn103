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

/** Get validator URLs — env override or metagraph discovery (shuffled). */
async function getValidatorUrls(): Promise<string[]> {
  const envUrl = process.env.VALIDATOR_URL || process.env.NEXT_PUBLIC_VALIDATOR_URL;
  if (envUrl) return [envUrl];
  try {
    const urls = await discoverValidatorUrls();
    if (urls.length > 0) return shuffle([...urls]);
  } catch {
    // fall through
  }
  return ["http://localhost:8421"];
}

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 150_000; // 150s per attempt (TLSNotary takes up to 90s)

/**
 * POST /api/attest — Proxy attestation requests to validators with fallback.
 *
 * Tries up to 3 randomly-selected validators sequentially. Each attempt has
 * a 150s timeout to accommodate TLSNotary proof generation.
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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Server-side validation
  if (!body.url || typeof body.url !== "string" || !body.url.startsWith("https://") || body.url.length > 2048) {
    return NextResponse.json({ error: "URL must start with https:// and be under 2048 chars" }, { status: 400 });
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
      return NextResponse.json({ error: "Private/internal URLs not allowed" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!body.request_id || typeof body.request_id !== "string" || body.request_id.length > 256) {
    return NextResponse.json({ error: "request_id is required (max 256 chars)" }, { status: 400 });
  }

  const sanitizedBody = {
    url: body.url,
    request_id: body.request_id,
  };

  const validators = await getValidatorUrls();
  const attempts = Math.min(MAX_ATTEMPTS, validators.length);
  let lastError = "No validators available";

  for (let i = 0; i < attempts; i++) {
    const target = `${validators[i]}/v1/attest`;
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sanitizedBody),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const text = await res.text();
        return new NextResponse(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Non-200 = validator can't handle it, try next
      lastError = `Validator ${i + 1}/${attempts} returned ${res.status}`;
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        lastError = `Validator ${i + 1}/${attempts} timed out`;
      } else {
        lastError = `Validator ${i + 1}/${attempts} unavailable`;
      }
      // Try next validator
    }
  }

  return NextResponse.json({ error: lastError }, { status: 502 });
}
