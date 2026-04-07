/**
 * High-level signal creation for the Djinn Protocol.
 *
 * Orchestrates: encryption, decoy placement, Shamir splitting,
 * and share preparation. The plaintext pick never leaves this module.
 *
 * Usage:
 *   const encrypted = await encryptSignal({ pick, decoys, validators, ... });
 *   // encrypted.blob, encrypted.hash, encrypted.shares are all ciphertext
 *   // Send encrypted.shares to validators via POST /api/genius/signal/commit
 */

import {
  generateAesKey,
  encrypt,
  splitSecret,
  keyToBigInt,
  toHex,
  type ShamirShare,
} from "./crypto";
import { keccak256, AbiCoder } from "ethers";

export interface ValidatorInfo {
  uid: number;
  pubkey: string;
}

export interface SignalConfig {
  /** The real pick as a structured line object */
  pick: Record<string, unknown>;
  /** 9 decoy lines (from generateDecoys) */
  decoys: Record<string, unknown>[];
  /** Validators to distribute shares to */
  validators: ValidatorInfo[];
  /** Shamir threshold (k-of-n) */
  shamirK: number;
}

export interface EncryptedSignal {
  /** Hex-encoded encrypted blob containing all lines */
  blob: string;
  /** Hex-encoded IV for AES-GCM */
  iv: string;
  /** Keccak256 hash of the blob (for on-chain commitment) */
  hash: string;
  /** Keccak256 hash of the serialized lines array (for on-chain tamper seal) */
  linesHash: string;
  /** Total number of lines (1 real + N decoys) */
  lineCount: number;
  /** JSON-serialized lines for validator distribution */
  serializedLines: string[];
  /** The real pick's index within the lines (1-indexed, for Shamir) */
  realIndex: number;
  /** Per-validator shares: key share and index share */
  shares: {
    validatorUid: number;
    keyShare: string; // hex-encoded Shamir y-value
    indexShare: string; // hex-encoded Shamir y-value
    shareX: number; // Shamir x-coordinate
  }[];
  /** The raw AES key (keep locally for decryption, never send to server) */
  localKey: Uint8Array;
}

/**
 * Encrypt a signal with decoys, split the key and index via Shamir,
 * and prepare shares for distribution to validators.
 *
 * SECURITY INVARIANT: The plaintext pick exists only in memory during
 * this function call. The returned EncryptedSignal contains only
 * ciphertext, shares, and the local key (which stays on the client).
 */
export async function encryptSignal(config: SignalConfig): Promise<EncryptedSignal> {
  const { pick, decoys, validators, shamirK } = config;

  if (decoys.length < 1) {
    throw new Error("Need at least 1 decoy");
  }

  if (shamirK > validators.length) {
    throw new Error(`shamirK (${shamirK}) exceeds validator count (${validators.length})`);
  }

  // Place the real pick at a random position among all lines
  const lines: Record<string, unknown>[] = [...decoys];
  const realIndex = Math.floor(Math.random() * (lines.length + 1)); // 0-indexed, any position including end
  lines.splice(realIndex, 0, pick);

  if (lines.length < 2) {
    throw new Error(`Expected at least 2 lines after insertion, got ${lines.length}`);
  }

  // Encrypt the 10 lines as JSON
  const aesKey = generateAesKey();
  const plaintext = JSON.stringify(lines);
  const { ciphertext, iv } = await encrypt(plaintext, aesKey);

  // Compute commitment hash (SHA-256 of ciphertext bytes)
  const ctBytes = hexToBytes(ciphertext);
  const hashBuffer = await crypto.subtle.digest("SHA-256", ctBytes.buffer as ArrayBuffer);
  const hash = toHex(new Uint8Array(hashBuffer));

  // Shamir-split the AES key
  const keyBigInt = keyToBigInt(aesKey);
  const n = validators.length;
  const keyShares = splitSecret(keyBigInt, n, shamirK);

  // Shamir-split the real index (1-indexed for Shamir, since x=0 is the secret)
  const realIndex1 = BigInt(realIndex + 1);
  const indexShares = splitSecret(realIndex1, n, shamirK);

  // Format shares for each validator
  const shares = validators.map((v, i) => ({
    validatorUid: v.uid,
    keyShare: keyShares[i].y.toString(16).padStart(64, "0"),
    indexShare: indexShares[i].y.toString(16).padStart(64, "0"),
    shareX: keyShares[i].x,
  }));

  // Compute lines hash for on-chain tamper seal
  const serializedLines = lines.map((l) => JSON.stringify(l));
  const linesHash = computeLinesHash(serializedLines);

  return {
    blob: ciphertext,
    iv,
    hash,
    linesHash,
    lineCount: lines.length,
    serializedLines,
    realIndex: realIndex + 1, // 1-indexed
    shares,
    localKey: aesKey,
  };
}

/**
 * Compute keccak256 hash of a string array (abi-encoded).
 * Used as on-chain tamper seal for the line set.
 */
export function computeLinesHash(lines: string[]): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(["string[]"], [lines]);
  return keccak256(encoded);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
