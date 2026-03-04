/**
 * Minimal SS58 address encoder/decoder.
 *
 * Converts between SS58-encoded Substrate addresses (like Bittensor hotkeys)
 * and raw hex public keys.
 */

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): Uint8Array {
  const BASE = 58n;
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * BASE + BigInt(idx);
  }

  // Convert bigint to bytes
  const hex = num.toString(16);
  const paddedHex = hex.length % 2 ? "0" + hex : hex;
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }

  // Count leading '1' chars (base58 zero bytes)
  let leadingZeros = 0;
  for (const char of str) {
    if (char === "1") leadingZeros++;
    else break;
  }

  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);
  return result;
}

// ---------------------------------------------------------------------------
// Encode: hex public key → SS58 address
// ---------------------------------------------------------------------------

function base58Encode(bytes: Uint8Array): string {
  const BASE = 58n;
  // Count leading zeros
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b === 0) leadingZeros++;
    else break;
  }
  // Convert bytes to bigint
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  // Convert bigint to base58 digits
  const digits: string[] = [];
  while (num > 0n) {
    digits.push(BASE58_ALPHABET[Number(num % BASE)]);
    num /= BASE;
  }
  return "1".repeat(leadingZeros) + digits.reverse().join("");
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encode a 32-byte hex public key to SS58 with the given prefix (default 42 for Substrate/Bittensor). */
export function hexToSs58(hex: string, prefix = 42): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto");
  const pubkey = hexToBytes(hex);
  if (pubkey.length !== 32) throw new Error("Expected 32-byte public key");

  const SS58_PREFIX = new TextEncoder().encode("SS58PRE");
  const payload = new Uint8Array(SS58_PREFIX.length + 1 + 32);
  payload.set(SS58_PREFIX);
  payload[SS58_PREFIX.length] = prefix;
  payload.set(pubkey, SS58_PREFIX.length + 1);

  const hash: Buffer = crypto.createHash("blake2b512").update(payload).digest();
  const checksum = hash.slice(0, 2);

  const full = new Uint8Array(1 + 32 + 2);
  full[0] = prefix;
  full.set(pubkey, 1);
  full.set(checksum, 33);
  return base58Encode(full);
}

// ---------------------------------------------------------------------------
// Decode: SS58 address → hex public key
// ---------------------------------------------------------------------------

/** Extract the 32-byte public key from an SS58 address and return it as hex. */
export function ss58ToHex(ss58: string): string {
  const decoded = base58Decode(ss58);
  // Simple prefix (< 64): 1 byte prefix + 32 bytes key + 2 bytes checksum
  // Two-byte prefix (>= 64): 2 bytes prefix + 32 bytes key + 2 bytes checksum
  const prefixLen = decoded[0] < 64 ? 1 : 2;
  const pubkey = decoded.slice(prefixLen, prefixLen + 32);
  return Array.from(pubkey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
