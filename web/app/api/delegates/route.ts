import { NextResponse } from "next/server";
import { ss58ToHex } from "@/lib/ss58";
import { hexToBytes } from "@/lib/scale";

const DELEGATES_URL =
  "https://raw.githubusercontent.com/opentensor/bittensor-delegates/main/public/delegates.json";

const SUBTENSOR_RPCS = [
  "https://entrypoint-finney.opentensor.ai",
  "https://lite.chain.opentensor.ai",
];

interface DelegateEntry {
  name: string;
  url: string;
  description: string;
}

type DelegateRegistry = Record<string, DelegateEntry>;

/** Cache the delegate map for 10 minutes. */
let cache: { map: Record<string, string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Query SubtensorModule.Owner storage to get coldkey for a hotkey.
 * Storage key: twox128("SubtensorModule") ++ twox128("Owner") ++ blake2_128_concat(hotkey)
 *
 * We use a simpler approach: batch-query using state_queryStorageAt.
 */
async function queryOwnerColdkeys(
  hotkeyHexes: string[],
  rpcUrl: string,
): Promise<Record<string, string>> {
  // SubtensorModule.Owner storage prefix (pre-computed twox128 hashes)
  // twox128("SubtensorModule") = 0x658faa385070e074c85bf6b568cf0555
  // twox128("Owner")           = 0x4de0681e6c0cf68b808e5a9a63f9a818
  const PREFIX = "658faa385070e074c85bf6b568cf0555" + "4de0681e6c0cf68b808e5a9a63f9a818";

  // Build storage keys using Blake2-128 concat
  const storageKeys: string[] = [];
  for (const hex of hotkeyHexes) {
    // blake2_128_concat: blake2b_128(key) ++ key
    const keyBytes = hexToBytes("0x" + hex);
    const hash = await blake2_128(keyBytes);
    storageKeys.push("0x" + PREFIX + hash + hex);
  }

  // Batch query
  const result: Record<string, string> = {};
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "state_queryStorageAt",
        params: [storageKeys],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    if (json.result?.[0]?.changes) {
      for (const [key, value] of json.result[0].changes) {
        // Extract hotkey hex from storage key (last 64 chars = 32 bytes)
        const hotkeyHex = (key as string).slice(-64);
        // Value is the coldkey AccountId (32 bytes)
        if (value && typeof value === "string" && value.length >= 66) {
          const coldkeyHex = (value as string).slice(2, 66); // strip 0x, take 32 bytes
          result[hotkeyHex] = coldkeyHex;
        }
      }
    }
  } catch (err) {
    console.warn("[delegates] Owner query failed:", err);
  }

  return result;
}

/** Simple Blake2b-128 using SubtleCrypto (not available) — use manual implementation. */
async function blake2_128(input: Uint8Array): Promise<string> {
  // We need blake2b-128 which isn't in SubtleCrypto.
  // Use a minimal JS implementation.
  const hash = blake2b(input, 16); // 16 bytes = 128 bits
  return Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Minimal Blake2b implementation (RFC 7693) for 128-bit output
function blake2b(input: Uint8Array, outlen: number): Uint8Array {
  // Blake2b constants
  const IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  const SIGMA = [
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
    [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
    [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
    [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],
    [2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
    [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],
    [13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
    [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
    [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0],
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
  ];

  const v = new BigUint64Array(16);
  const m = new BigUint64Array(16);

  function rotr64(x: bigint, n: number): bigint {
    return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & 0xffffffffffffffffn;
  }

  function G(a: number, b: number, c: number, d: number, x: bigint, y: bigint) {
    v[a] = (v[a] + v[b] + x) & 0xffffffffffffffffn;
    v[d] = rotr64(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & 0xffffffffffffffffn;
    v[b] = rotr64(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & 0xffffffffffffffffn;
    v[d] = rotr64(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & 0xffffffffffffffffn;
    v[b] = rotr64(v[b] ^ v[c], 63);
  }

  // Initialize state
  const h = new BigUint64Array(IV);
  h[0] ^= 0x01010000n ^ BigInt(outlen); // param block

  // Pad input to 128-byte blocks
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  const padded = new Uint8Array(blocks * 128);
  padded.set(input);

  for (let i = 0; i < blocks; i++) {
    const isLast = i === blocks - 1;
    const offset = i * 128;

    // Load message block as little-endian u64s
    const view = new DataView(padded.buffer, offset, 128);
    for (let j = 0; j < 16; j++) {
      m[j] = view.getBigUint64(j * 8, true);
    }

    // Init working vector
    for (let j = 0; j < 8; j++) { v[j] = h[j]; v[j + 8] = IV[j]; }

    const t = BigInt(isLast ? input.length : (i + 1) * 128);
    v[12] ^= t; // low 64 bits of counter
    if (isLast) v[14] ^= 0xffffffffffffffffn; // finalization flag

    // 12 rounds
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r];
      G(0,4,8,12,m[s[0]],m[s[1]]);   G(1,5,9,13,m[s[2]],m[s[3]]);
      G(2,6,10,14,m[s[4]],m[s[5]]);  G(3,7,11,15,m[s[6]],m[s[7]]);
      G(0,5,10,15,m[s[8]],m[s[9]]);  G(1,6,11,12,m[s[10]],m[s[11]]);
      G(2,7,8,13,m[s[12]],m[s[13]]); G(3,4,9,14,m[s[14]],m[s[15]]);
    }

    for (let j = 0; j < 8; j++) h[j] ^= v[j] ^ v[j + 8];
  }

  // Extract output
  const out = new Uint8Array(outlen);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < Math.ceil(outlen / 8); i++) {
    if (i * 8 + 8 <= outlen) {
      outView.setBigUint64(i * 8, h[i], true);
    } else {
      // Partial last word
      const tmp = new Uint8Array(8);
      new DataView(tmp.buffer).setBigUint64(0, h[i], true);
      out.set(tmp.slice(0, outlen - i * 8), i * 8);
    }
  }
  return out;
}

/**
 * Returns a map of hex key → delegate name.
 * Keys include both hotkeys and coldkeys so SN103 nodes can be matched
 * even when they use a different hotkey than their root-network delegate key.
 */
export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.map, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  }

  try {
    const res = await fetch(DELEGATES_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`delegates.json fetch failed: ${res.status}`);

    const registry: DelegateRegistry = await res.json();
    const map: Record<string, string> = {};
    const hotkeyHexes: string[] = [];
    const hotkeyToName: Record<string, string> = {};

    for (const [ss58, info] of Object.entries(registry)) {
      try {
        const hex = ss58ToHex(ss58);
        map[hex] = info.name;
        hotkeyHexes.push(hex);
        hotkeyToName[hex] = info.name;
      } catch {
        // Skip entries with invalid SS58 addresses
      }
    }

    // Resolve coldkeys for all delegate hotkeys so we can match by coldkey on subnets
    let ownerMap: Record<string, string> = {};
    for (const rpcUrl of SUBTENSOR_RPCS) {
      try {
        ownerMap = await queryOwnerColdkeys(hotkeyHexes, rpcUrl);
        if (Object.keys(ownerMap).length > 0) break;
      } catch {
        continue;
      }
    }

    // Add coldkey → name mappings
    for (const [hotkey, coldkey] of Object.entries(ownerMap)) {
      const name = hotkeyToName[hotkey];
      if (name && coldkey && !map[coldkey]) {
        map[coldkey] = name;
      }
    }

    cache = { map, fetchedAt: now };
    return NextResponse.json(map, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (err) {
    console.error("[delegates] Failed to fetch delegate names:", err);
    return NextResponse.json(cache?.map ?? {}, { status: cache ? 200 : 502 });
  }
}
