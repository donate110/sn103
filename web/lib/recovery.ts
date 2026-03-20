/**
 * Key recovery: encrypt signal data to a signature-derived AES key and
 * store/retrieve it from the KeyRecovery contract on-chain.
 *
 * Flow:
 *   1. User signs a deterministic message "Djinn Key Recovery v1"
 *   2. SHA-256 hash of the signature => 32-byte AES-256 key
 *   3. Signal data array is JSON-serialized and AES-GCM encrypted
 *   4. Encrypted blob is stored on-chain via KeyRecovery.storeRecoveryBlob()
 *   5. Recovery: sign same message => same key => decrypt blob from chain
 *
 * Security: The key is derived from a wallet signature that only the private
 * key holder can produce. Most wallets use RFC 6979 (deterministic k), so the
 * same message always yields the same signature and thus the same AES key.
 */

import { encrypt, decrypt, toHex, fromHex, deriveMasterSeedTyped } from "./crypto";
import type { SignTypedDataParams } from "./crypto";
import { getKeyRecoveryContract, ADDRESSES } from "./contracts";
import { getReadProvider } from "./hooks";
import type { SavedSignalData } from "./hooks/useSettledSignals";
import type { PurchasedSignalData } from "./preferences";

const RECOVERY_SIGN_MESSAGE = "Djinn Key Recovery v1";
const MAX_BLOB_SIZE = 4096;

// ---- Types ----

interface RecoveryBlobPayloadV1 {
  version: 1;
  signals: SavedSignalData[];
}

interface RecoveryBlobPayloadV2 {
  version: 2;
  signals: SavedSignalData[];
  purchases: PurchasedSignalData[];
}

type RecoveryBlobPayload = RecoveryBlobPayloadV1 | RecoveryBlobPayloadV2;

export interface RecoveryResult {
  signals: SavedSignalData[];
  purchases: PurchasedSignalData[];
}

// ---- Key Derivation ----

export async function deriveRecoveryKey(signature: string): Promise<Uint8Array> {
  const sigBytes = fromHex(signature.replace(/^0x/, ""));
  // Convert to ArrayBuffer for Web Crypto API compatibility
  const buffer = sigBytes.buffer instanceof ArrayBuffer
    ? sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength)
    : new Uint8Array(sigBytes).buffer as ArrayBuffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return new Uint8Array(hashBuffer);
}

// ---- Encrypt / Decrypt ----

export async function encryptRecoveryBlob(
  signals: SavedSignalData[],
  recoveryKey: Uint8Array,
  purchases?: PurchasedSignalData[],
): Promise<Uint8Array> {
  const payload: RecoveryBlobPayload =
    purchases && purchases.length > 0
      ? { version: 2, signals, purchases }
      : { version: 1, signals };
  const plaintext = JSON.stringify(payload);
  const { ciphertext, iv } = await encrypt(plaintext, recoveryKey);
  return new TextEncoder().encode(`${iv}:${ciphertext}`);
}

export async function decryptRecoveryBlob(
  blob: Uint8Array,
  recoveryKey: Uint8Array,
): Promise<RecoveryResult> {
  const packed = new TextDecoder().decode(blob);
  const colonIdx = packed.indexOf(":");
  if (colonIdx < 0) {
    throw new Error(
      "Recovery blob is corrupted (invalid format). " +
      "This may happen if the blob was truncated during storage. " +
      "Your on-chain data (purchases, settlements) is unaffected."
    );
  }
  const iv = packed.slice(0, colonIdx);
  const ciphertext = packed.slice(colonIdx + 1);

  let json: string;
  try {
    json = await decrypt(ciphertext, iv, recoveryKey);
  } catch {
    throw new Error(
      "Could not decrypt recovery blob. This usually means the blob was stored " +
      "with a different wallet or was corrupted. Your on-chain data is unaffected."
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(
      "Recovery blob decrypted but contains invalid data. " +
      "Your on-chain data (purchases, settlements) is unaffected."
    );
  }

  if (raw?.version !== 1 && raw?.version !== 2) {
    throw new Error(
      `Unsupported recovery blob version: ${raw?.version}. ` +
      "You may need a newer version of the app to read this backup."
    );
  }

  const payload = raw as unknown as RecoveryBlobPayload;

  // Graceful degradation: filter out malformed entries instead of failing entirely
  const signals = Array.isArray(payload.signals)
    ? payload.signals.filter(
        (s): s is SavedSignalData => typeof s === "object" && s !== null && "signalId" in s
      )
    : [];

  const purchases =
    payload.version === 2 && Array.isArray(payload.purchases)
      ? payload.purchases.filter(
          (p): p is PurchasedSignalData => typeof p === "object" && p !== null && "signalId" in p
        )
      : [];

  return { signals, purchases };
}

// ---- On-Chain Read (view, no gas) ----

export async function readRecoveryBlobFromChain(
  userAddress: string,
): Promise<Uint8Array | null> {
  if (ADDRESSES.keyRecovery === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  const contract = getKeyRecoveryContract(getReadProvider());
  const blob: string = await contract.getRecoveryBlob(userAddress);
  if (!blob || blob === "0x" || blob.length <= 2) return null;
  return fromHex(blob.replace(/^0x/, ""));
}

// ---- On-Chain Write ----

const KEY_RECOVERY_VIEM_ABI = [
  {
    type: "function" as const,
    name: "storeRecoveryBlob" as const,
    inputs: [{ name: "blob" as const, type: "bytes" as const }],
    outputs: [],
    stateMutability: "nonpayable" as const,
  },
] as const;

export async function storeRecoveryBlobOnChain(
  walletClient: { writeContract: (args: any) => Promise<`0x${string}`>; account?: { address: `0x${string}` }; chain?: { id: number } },
  blob: Uint8Array,
  waitForTxFn: (hash: `0x${string}`) => Promise<void>,
): Promise<`0x${string}`> {
  if (blob.length === 0) throw new Error("Recovery blob is empty");
  if (blob.length > MAX_BLOB_SIZE) {
    throw new Error(
      `Recovery blob too large: ${blob.length} bytes (max ${MAX_BLOB_SIZE}). ` +
      `Consider pruning old signals.`,
    );
  }

  const hash = await walletClient.writeContract({
    address: ADDRESSES.keyRecovery as `0x${string}`,
    abi: KEY_RECOVERY_VIEM_ABI,
    functionName: "storeRecoveryBlob",
    account: walletClient.account?.address,
    chain: walletClient.chain,
    args: [`0x${toHex(blob)}`],
  });

  await waitForTxFn(hash);
  return hash;
}

// ---- High-Level Orchestration ----

export async function storeRecovery(
  signTypedDataFn: (params: SignTypedDataParams) => Promise<string>,
  walletClient: { writeContract: (args: any) => Promise<`0x${string}`> },
  signals: SavedSignalData[],
  waitForTxFn: (hash: `0x${string}`) => Promise<void>,
  purchases?: PurchasedSignalData[],
): Promise<`0x${string}`> {
  if (signals.length === 0 && (!purchases || purchases.length === 0)) {
    throw new Error("No data to store for recovery");
  }
  if (ADDRESSES.keyRecovery === "0x0000000000000000000000000000000000000000") {
    throw new Error("KeyRecovery contract not configured");
  }

  const masterSeed = await deriveMasterSeedTyped(signTypedDataFn);
  const blob = await encryptRecoveryBlob(signals, masterSeed, purchases);
  return storeRecoveryBlobOnChain(walletClient, blob, waitForTxFn);
}

export async function loadRecovery(
  userAddress: string,
  signTypedDataFn: (params: SignTypedDataParams) => Promise<string>,
): Promise<RecoveryResult | null> {
  const blob = await readRecoveryBlobFromChain(userAddress);
  if (!blob) return null;

  const masterSeed = await deriveMasterSeedTyped(signTypedDataFn);
  return decryptRecoveryBlob(blob, masterSeed);
}
