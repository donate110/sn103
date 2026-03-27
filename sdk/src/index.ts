/**
 * @djinn/sdk - Client-side SDK for the Djinn Protocol
 *
 * This SDK handles all cryptographic operations locally so that the
 * genius's real pick never leaves the client device.
 *
 * Usage:
 *   import { createSignal, encryptSignal, splitIndex } from "@djinn/sdk";
 */

export { BN254_PRIME } from "./crypto";
export type { ShamirShare } from "./crypto";
export {
  splitSecret,
  reconstructSecret,
  generateAesKey,
  encrypt,
  decrypt,
  keyToBigInt,
  bigIntToKey,
  toHex,
  fromHex,
} from "./crypto";

export {
  generateDecoys,
  type DecoyConfig,
} from "./decoys";

export {
  encryptSignal,
  type EncryptedSignal,
  type SignalConfig,
  type ValidatorInfo,
} from "./signal";
