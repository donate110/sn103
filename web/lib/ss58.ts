/**
 * Minimal SS58 address decoder.
 *
 * Converts SS58-encoded Substrate addresses (like Bittensor hotkeys) to
 * raw hex public keys. Only implements decoding — no checksum verification
 * needed since we're just matching keys, not validating addresses.
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
