import type { NextRequest } from "next/server";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Session token auth for the Djinn API (wallet-signature based)
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Challenges are stateless (HMAC-signed) so they work across serverless
// instances. No in-memory state needed.

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const _secret = process.env.API_SESSION_SECRET || process.env.ADMIN_PASSWORD;
if (!_secret) throw new Error("API_SESSION_SECRET or ADMIN_PASSWORD must be set");
const secret: string = _secret;

function getSecret(): string {
  return secret;
}

async function hmacSha256(key: string, data: string): Promise<string> {
  const keyBuf = encode(key).buffer as ArrayBuffer;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const dataBuf = encode(data).buffer as ArrayBuffer;
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, dataBuf);
  return toHex(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = encode(a);
  const bb = encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Challenge management
// ---------------------------------------------------------------------------

/**
 * Create a stateless challenge nonce. The nonce embeds the address and
 * timestamp, signed with HMAC so any serverless instance can verify it
 * without shared state.
 *
 * Format: {random32hex}:{address}:{timestamp}:{hmac}
 */
export async function createChallenge(address: string): Promise<string> {
  const random = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  const ts = Date.now().toString();
  const addr = address.toLowerCase();
  const payload = `${random}:${addr}:${ts}`;
  const sig = await hmacSha256(getSecret(), payload);
  return `${payload}:${sig}`;
}

/**
 * Verify and consume a stateless challenge nonce. Returns the random
 * component (used as the signing nonce) if valid, null otherwise.
 * "Consuming" is implicit: the nonce has a 5-minute TTL and the
 * wallet signature binds it to a specific address.
 */
export async function consumeChallenge(address: string, nonce: string): Promise<string | null> {
  const parts = nonce.split(":");
  if (parts.length !== 4) return null;

  const [random, addr, tsStr, sig] = parts;
  if (addr !== address.toLowerCase()) return null;

  const ts = parseInt(tsStr, 10);
  if (isNaN(ts) || Date.now() - ts > CHALLENGE_TTL_MS) return null;

  const payload = `${random}:${addr}:${tsStr}`;
  const expectedSig = await hmacSha256(getSecret(), payload);
  if (!constantTimeEqual(sig, expectedSig)) return null;

  return nonce;
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export interface SessionScope {
  role?: "genius" | "idiot" | "both";
  maxSpendUsdc?: number;
  expiresInHours?: number;
}

interface TokenPayload {
  address: string;
  scope: SessionScope;
  issuedAt: number;
  expiresAt: number;
}

export async function createSessionToken(
  address: string,
  scope: SessionScope = {},
): Promise<{ token: string; expiresAt: number }> {
  const ttlHours = scope.expiresInHours ?? 24;
  const ttlMs = Math.min(ttlHours * 60 * 60 * 1000, TOKEN_TTL_MS);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;

  const payload = JSON.stringify({
    address: address.toLowerCase(),
    scope: { role: scope.role ?? "both", maxSpendUsdc: scope.maxSpendUsdc },
    issuedAt,
    expiresAt,
  });

  const payloadB64 = btoa(payload);
  const sig = await hmacSha256(getSecret(), payloadB64);
  const token = `djn_${payloadB64}.${sig}`;

  return { token, expiresAt };
}

export async function verifySessionToken(token: string): Promise<TokenPayload | null> {
  const secret = getSecret();

  try {
    if (!token.startsWith("djn_")) return null;
    const rest = token.slice(4);
    const dotIdx = rest.lastIndexOf(".");
    if (dotIdx === -1) return null;

    const payloadB64 = rest.slice(0, dotIdx);
    const sig = rest.slice(dotIdx + 1);

    const expectedSig = await hmacSha256(secret, payloadB64);
    if (!constantTimeEqual(sig, expectedSig)) return null;

    const payload: TokenPayload = JSON.parse(atob(payloadB64));
    if (Date.now() > payload.expiresAt) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request authentication
// ---------------------------------------------------------------------------

export async function authenticateRequest(
  request: NextRequest,
): Promise<{ address: string; scope: SessionScope } | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  return {
    address: payload.address,
    scope: { role: payload.scope.role, maxSpendUsdc: payload.scope.maxSpendUsdc },
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

const CHALLENGE_MESSAGE_PREFIX = "Sign this message to authenticate with Djinn Protocol.\n\nNonce: ";

export function buildChallengeMessage(nonce: string): string {
  return `${CHALLENGE_MESSAGE_PREFIX}${nonce}`;
}

export function recoverAddress(nonce: string, signature: string): string | null {
  try {
    const message = buildChallengeMessage(nonce);
    return ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return null;
  }
}
