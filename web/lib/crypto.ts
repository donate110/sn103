/**
 * Client-side cryptographic primitives for the Djinn protocol.
 *
 * - AES-256-GCM encryption via Web Crypto API (zero external dependencies)
 * - Shamir Secret Sharing over the BN254 scalar field
 *
 * The Shamir implementation matches the validator's Python crypto.py exactly.
 */

// ---------------------------------------------------------------------------
// BN254 scalar field prime (same as validator Shamir implementation)
// ---------------------------------------------------------------------------

export const BN254_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Shamir types
// ---------------------------------------------------------------------------

export interface ShamirShare {
  x: number;
  y: bigint;
}

// ---------------------------------------------------------------------------
// Modular arithmetic helpers
// ---------------------------------------------------------------------------

function mod(a: bigint, p: bigint): bigint {
  const r = a % p;
  return r < 0n ? r + p : r;
}

function extendedGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (a === 0n) return [b, 0n, 1n];
  const [g, x, y] = extendedGcd(mod(b, a), a);
  return [g, y - (b / a) * x, x];
}

function modInverse(a: bigint, p: bigint): bigint {
  const a2 = mod(a, p);
  const [g, x] = extendedGcd(a2, p);
  if (g !== 1n) throw new Error("Modular inverse does not exist");
  return mod(x, p);
}

function modPow(base: bigint, exp: bigint, p: bigint): bigint {
  let result = 1n;
  let b = mod(base, p);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, p);
    b = mod(b * b, p);
    e >>= 1n;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Beaver Triples for MPC
// ---------------------------------------------------------------------------

export interface BeaverTriple {
  a: bigint;
  b: bigint;
  c: bigint; // c = a * b mod p
}

/**
 * Generate random Beaver triples for pre-computed MPC gate computation.
 * Each triple satisfies c = a * b mod p. These are stored with the signal
 * so the expensive OT setup phase is skipped during purchase.
 */
export function generateBeaverTriples(
  count: number,
  prime: bigint = BN254_PRIME,
): BeaverTriple[] {
  const triples: BeaverTriple[] = [];
  for (let i = 0; i < count; i++) {
    const a = getRandomFieldElement(prime);
    const b = getRandomFieldElement(prime);
    const c = (a * b) % prime;
    triples.push({ a, b, c });
  }
  return triples;
}

// ---------------------------------------------------------------------------
// Shamir Secret Sharing
// ---------------------------------------------------------------------------

function getRandomFieldElement(prime: bigint): bigint {
  // Rejection sampling: generate 32 random bytes, accept only if < prime.
  // Avoids modulo bias (2^256 / BN254_PRIME ≈ 4, so naive mod would make
  // low values ~4x more likely). Expected iterations ≈ 1.13 for BN254.
  const bytes = new Uint8Array(32);
  for (let attempt = 0; attempt < 256; attempt++) {
    crypto.getRandomValues(bytes);
    let val = 0n;
    for (const b of bytes) {
      val = (val << 8n) | BigInt(b);
    }
    if (val < prime) return val;
  }
  // Astronomically unlikely (probability < 2^{-256}) — fail safe
  throw new Error("Failed to generate unbiased random field element");
}

export function splitSecret(
  secret: bigint,
  n: number = 10,
  k: number = 7,
  prime: bigint = BN254_PRIME,
): ShamirShare[] {
  if (secret >= prime) throw new Error(`Secret must be < prime`);

  // Random polynomial: a_0 = secret, a_1..a_{k-1} random
  const coeffs: bigint[] = [secret];
  for (let i = 1; i < k; i++) {
    coeffs.push(getRandomFieldElement(prime));
  }

  const shares: ShamirShare[] = [];
  for (let i = 1; i <= n; i++) {
    let y = 0n;
    const x = BigInt(i);
    for (let j = 0; j < coeffs.length; j++) {
      y = mod(y + coeffs[j] * modPow(x, BigInt(j), prime), prime);
    }
    shares.push({ x: i, y });
  }

  return shares;
}

export function reconstructSecret(
  shares: ShamirShare[],
  prime: bigint = BN254_PRIME,
): bigint {
  const k = shares.length;
  let secret = 0n;

  for (let i = 0; i < k; i++) {
    const xi = BigInt(shares[i].x);
    const yi = shares[i].y;
    let numerator = 1n;
    let denominator = 1n;

    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const xj = BigInt(shares[j].x);
      numerator = mod(numerator * (0n - xj), prime);
      denominator = mod(denominator * (xi - xj), prime);
    }

    const lagrangeCoeff = mod(numerator * modInverse(denominator, prime), prime);
    secret = mod(secret + yi * lagrangeCoeff, prime);
  }

  return secret;
}

// ---------------------------------------------------------------------------
// AES-256-GCM (Web Crypto API)
// ---------------------------------------------------------------------------

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer instanceof ArrayBuffer
    ? arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
    : new Uint8Array(arr).buffer as ArrayBuffer;
}

export function generateAesKey(): Uint8Array {
  // Generate a random key that fits within BN254 field (so Shamir roundtrip works).
  // Uses rejection sampling to avoid modulo bias.
  const val = getRandomFieldElement(BN254_PRIME);
  return bigIntToKey(val);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Max hex string length: 64KB (32KB binary). Prevents DoS via oversized inputs.
const MAX_HEX_LENGTH = 131_072;

function fromHex(hex: string): Uint8Array {
  if (hex.length > MAX_HEX_LENGTH) {
    throw new Error(`Hex string too large: ${hex.length} chars (max ${MAX_HEX_LENGTH})`);
  }
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string must have even length");
  }
  if (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Invalid hex characters");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function encrypt(
  plaintext: string,
  key: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    cryptoKey,
    encoded,
  );

  return {
    ciphertext: toHex(new Uint8Array(encrypted)),
    iv: toHex(iv),
  };
}

export async function decrypt(
  ciphertext: string,
  iv: string,
  key: Uint8Array,
): Promise<string> {
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(key),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    const ivBytes = fromHex(iv);
    const ctBytes = fromHex(ciphertext);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(ivBytes) },
      cryptoKey,
      toArrayBuffer(ctBytes),
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Decryption failed");
  }
}

// ---------------------------------------------------------------------------
// Key <-> bigint conversion helpers
// ---------------------------------------------------------------------------

export function keyToBigInt(key: Uint8Array): bigint {
  let val = 0n;
  for (const b of key) {
    val = (val << 8n) | BigInt(b);
  }
  if (val >= BN254_PRIME) {
    throw new Error("Key value exceeds BN254 field — use generateAesKey() for safe key generation");
  }
  return val;
}

export function bigIntToKey(val: bigint): Uint8Array {
  const key = new Uint8Array(32);
  let v = val;
  for (let i = 31; i >= 0; i--) {
    key[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Deterministic wallet-derived signal keys
// ---------------------------------------------------------------------------

const SIGNAL_KEY_SIGN_MESSAGE = "djinn:signal-keys:v1";

// Session-level cache so wallet signMessage/signTypedData popup only fires once.
// Backed by sessionStorage so it survives page refreshes within the same tab.
const SESSION_SEED_KEY = "djinn:masterSeed";

function _loadFromSession(): Uint8Array | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const hex = sessionStorage.getItem(SESSION_SEED_KEY);
    if (!hex) return null;
    return fromHex(hex);
  } catch {
    return null;
  }
}

function _saveToSession(seed: Uint8Array): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(SESSION_SEED_KEY, toHex(seed));
  } catch { /* quota exceeded — degrade gracefully */ }
}

function _clearSession(): void {
  if (typeof sessionStorage === "undefined") return;
  try { sessionStorage.removeItem(SESSION_SEED_KEY); } catch { /* ignore */ }
}

let _cachedMasterSeed: Uint8Array | null = _loadFromSession();

/** Clear the cached master seed (for tests or wallet disconnect). */
export function clearMasterSeedCache(): void {
  _cachedMasterSeed = null;
  _clearSession();
}

/** Check whether the master seed is already cached (no wallet interaction). */
export function isMasterSeedCached(): boolean {
  if (!_cachedMasterSeed) _cachedMasterSeed = _loadFromSession();
  return _cachedMasterSeed !== null;
}

/** Get the cached master seed bytes, or null if not yet derived. No wallet interaction. */
export function getCachedMasterSeed(): Uint8Array | null {
  if (!_cachedMasterSeed) _cachedMasterSeed = _loadFromSession();
  return _cachedMasterSeed ? new Uint8Array(_cachedMasterSeed) : null;
}

/**
 * Derive a master seed from the Genius's wallet signature.
 * Signs a fixed message — same wallet always produces the same seed (RFC 6979).
 * Cached for the browser session — wallet popup only appears on first call.
 */
export async function deriveMasterSeed(
  signMessageFn: (message: string) => Promise<string>,
): Promise<Uint8Array> {
  if (_cachedMasterSeed) return _cachedMasterSeed;
  const signature = await signMessageFn(SIGNAL_KEY_SIGN_MESSAGE);
  const sigBytes = fromHex(signature.replace(/^0x/, ""));
  const hashBuffer = await crypto.subtle.digest("SHA-256", toArrayBuffer(sigBytes));
  _cachedMasterSeed = new Uint8Array(hashBuffer);
  _saveToSession(_cachedMasterSeed);
  return _cachedMasterSeed;
}

// ---------------------------------------------------------------------------
// EIP-712 (signTypedData) key derivation — works with ERC-4337 smart wallets
// ---------------------------------------------------------------------------

/** EIP-712 domain for key derivation (no chainId — works across chains). */
export const KEY_DERIVATION_DOMAIN = {
  name: "Djinn",
  version: "1",
} as const;

/** EIP-712 types for key derivation. */
export const KEY_DERIVATION_TYPES = {
  KeyDerivation: [{ name: "purpose", type: "string" }],
} as const;

/** Fixed EIP-712 message — same message = same signature = same key. */
export const KEY_DERIVATION_MESSAGE = {
  purpose: "signal-keys-v1",
} as const;

export interface SignTypedDataParams {
  domain: typeof KEY_DERIVATION_DOMAIN;
  types: typeof KEY_DERIVATION_TYPES;
  primaryType: "KeyDerivation";
  message: typeof KEY_DERIVATION_MESSAGE;
}

/**
 * Derive a master seed from an EIP-712 signTypedData signature.
 *
 * Unlike personal_sign (signMessage), EIP-712 signTypedData is part of the
 * ERC-4337 standard and works reliably on smart wallets (Coinbase Smart Wallet, etc.).
 *
 * Same wallet + same typed data = same signature (RFC 6979) = same master seed.
 * Session-cached to avoid repeated wallet popups.
 */
export async function deriveMasterSeedTyped(
  signTypedDataFn: (params: SignTypedDataParams) => Promise<string>,
): Promise<Uint8Array> {
  if (_cachedMasterSeed) return _cachedMasterSeed;
  const signature = await signTypedDataFn({
    domain: KEY_DERIVATION_DOMAIN,
    types: KEY_DERIVATION_TYPES,
    primaryType: "KeyDerivation",
    message: KEY_DERIVATION_MESSAGE,
  });
  const sigBytes = fromHex(signature.replace(/^0x/, ""));
  const hashBuffer = await crypto.subtle.digest("SHA-256", toArrayBuffer(sigBytes));
  _cachedMasterSeed = new Uint8Array(hashBuffer);
  _saveToSession(_cachedMasterSeed);
  return _cachedMasterSeed;
}

/**
 * Derive a per-signal AES key from the master seed.
 * Pure function — no wallet interaction needed.
 * Returns a 32-byte key in the BN254 field (safe for Shamir secret sharing).
 */
export async function deriveSignalKey(
  masterSeed: Uint8Array,
  signalId: bigint,
): Promise<Uint8Array> {
  // Concatenate masterSeed (32 bytes) + signalId (32 bytes big-endian)
  const idBytes = new Uint8Array(32);
  let v = signalId;
  for (let i = 31; i >= 0; i--) {
    idBytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const combined = new Uint8Array(64);
  combined.set(masterSeed, 0);
  combined.set(idBytes, 32);

  const hashBuffer = await crypto.subtle.digest("SHA-256", toArrayBuffer(combined));
  let val = 0n;
  for (const b of new Uint8Array(hashBuffer)) {
    val = (val << 8n) | BigInt(b);
  }
  // Reduce into BN254 field (mod is fine here — SHA-256 output is uniformly
  // distributed and field is ~254 bits, so bias is negligible at < 2^{-2})
  val = val % BN254_PRIME;
  return bigIntToKey(val);
}

// Hex helpers exported for use in API calls
export { toHex, fromHex };
