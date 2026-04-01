import type { NextRequest } from "next/server";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Session token auth for the Djinn API (wallet-signature based)
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// In-memory challenge store (vercel serverless: ephemeral, but challenges
// are short-lived so this is fine. Each function instance sees its own map.)
const challenges: Map<string, { nonce: string; ts: number }> = new Map();
const MAX_CHALLENGES = 10_000;

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getSecret(): string {
  return process.env.API_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
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

export function createChallenge(address: string): string {
  // Evict expired challenges
  if (challenges.size > MAX_CHALLENGES) {
    const now = Date.now();
    for (const [key, val] of challenges) {
      if (now - val.ts > CHALLENGE_TTL_MS) challenges.delete(key);
    }
  }

  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  const key = address.toLowerCase();
  challenges.set(key, { nonce, ts: Date.now() });
  return nonce;
}

export function consumeChallenge(address: string): string | null {
  const key = address.toLowerCase();
  const entry = challenges.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CHALLENGE_TTL_MS) {
    challenges.delete(key);
    return null;
  }
  challenges.delete(key);
  return entry.nonce;
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
  if (!secret) return null;

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
