import { describe, it, expect } from "vitest";
import {
  BN254_PRIME,
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

describe("Shamir Secret Sharing", () => {
  it("splits and reconstructs a secret with default params", () => {
    const secret = 42n;
    const shares = splitSecret(secret, 10, 7);
    expect(shares).toHaveLength(10);

    // Reconstruct from first 7 shares
    const reconstructed = reconstructSecret(shares.slice(0, 7));
    expect(reconstructed).toBe(secret);
  });

  it("reconstructs from any k shares", () => {
    const secret = 12345n;
    const shares = splitSecret(secret, 5, 3);

    // Try different subsets of 3 shares
    expect(reconstructSecret([shares[0], shares[1], shares[2]])).toBe(secret);
    expect(reconstructSecret([shares[0], shares[2], shares[4]])).toBe(secret);
    expect(reconstructSecret([shares[1], shares[3], shares[4]])).toBe(secret);
  });

  it("fails to reconstruct with fewer than k shares", () => {
    const secret = 99n;
    const shares = splitSecret(secret, 5, 3);
    // 2 shares should NOT reconstruct the secret (with overwhelming probability)
    const wrong = reconstructSecret([shares[0], shares[1]]);
    expect(wrong).not.toBe(secret);
  });

  it("handles the maximum field element", () => {
    const secret = BN254_PRIME - 1n;
    const shares = splitSecret(secret, 3, 2);
    const reconstructed = reconstructSecret(shares.slice(0, 2));
    expect(reconstructed).toBe(secret);
  });

  it("throws for secret >= prime", () => {
    expect(() => splitSecret(BN254_PRIME, 3, 2)).toThrow("Secret must be < prime");
  });

  it("handles secret = 0", () => {
    const shares = splitSecret(0n, 5, 3);
    const reconstructed = reconstructSecret(shares.slice(0, 3));
    expect(reconstructed).toBe(0n);
  });

  it("handles k=1 (no threshold security)", () => {
    const secret = 777n;
    const shares = splitSecret(secret, 3, 1);
    // Any single share should reconstruct
    expect(reconstructSecret([shares[0]])).toBe(secret);
    expect(reconstructSecret([shares[2]])).toBe(secret);
  });
});

describe("AES-256-GCM encryption", () => {
  it("encrypts and decrypts a message", async () => {
    const key = generateAesKey();
    const plaintext = "Hello, Djinn!";
    const { ciphertext, iv } = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, iv, key);
    expect(decrypted).toBe(plaintext);
  });

  it("generates keys within BN254 field", () => {
    for (let i = 0; i < 10; i++) {
      const key = generateAesKey();
      const val = keyToBigInt(key);
      expect(val).toBeLessThan(BN254_PRIME);
      expect(val).toBeGreaterThan(0n);
    }
  });

  it("ciphertext is different from plaintext", async () => {
    const key = generateAesKey();
    const plaintext = "secret pick";
    const { ciphertext } = await encrypt(plaintext, key);
    expect(ciphertext).not.toContain("secret");
    expect(ciphertext).not.toContain("pick");
  });

  it("different keys produce different ciphertext", async () => {
    const key1 = generateAesKey();
    const key2 = generateAesKey();
    const plaintext = "same message";
    const { ciphertext: ct1 } = await encrypt(plaintext, key1);
    const { ciphertext: ct2 } = await encrypt(plaintext, key2);
    expect(ct1).not.toBe(ct2);
  });

  it("wrong key fails to decrypt", async () => {
    const key1 = generateAesKey();
    const key2 = generateAesKey();
    const { ciphertext, iv } = await encrypt("test", key1);
    await expect(decrypt(ciphertext, iv, key2)).rejects.toThrow();
  });

  it("handles empty string", async () => {
    const key = generateAesKey();
    const { ciphertext, iv } = await encrypt("", key);
    const decrypted = await decrypt(ciphertext, iv, key);
    expect(decrypted).toBe("");
  });

  it("handles unicode", async () => {
    const key = generateAesKey();
    const plaintext = "Celtics -4.5 (-110) \u2714";
    const { ciphertext, iv } = await encrypt(plaintext, key);
    const decrypted = await decrypt(ciphertext, iv, key);
    expect(decrypted).toBe(plaintext);
  });
});

describe("Key/BigInt conversion", () => {
  it("roundtrips key to bigint and back", () => {
    const key = generateAesKey();
    const val = keyToBigInt(key);
    const back = bigIntToKey(val);
    expect(toHex(back)).toBe(toHex(key));
  });

  it("throws for key exceeding field", () => {
    const badKey = new Uint8Array(32);
    badKey.fill(0xff);
    expect(() => keyToBigInt(badKey)).toThrow("exceeds BN254 field");
  });
});

describe("Hex utilities", () => {
  it("converts bytes to hex and back", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const hex = toHex(bytes);
    expect(hex).toBe("000102ff8040");
    const back = fromHex(hex);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("handles empty input", () => {
    expect(toHex(new Uint8Array([]))).toBe("");
    expect(Array.from(fromHex(""))).toEqual([]);
  });

  it("rejects odd-length hex", () => {
    expect(() => fromHex("abc")).toThrow("even length");
  });

  it("rejects invalid hex characters", () => {
    expect(() => fromHex("xyz1")).toThrow("Invalid hex");
  });
});

describe("Shamir + AES integration", () => {
  it("splits a key via Shamir and reconstructs for decryption", async () => {
    const key = generateAesKey();
    const keyVal = keyToBigInt(key);
    const shares = splitSecret(keyVal, 5, 3);

    // Encrypt with original key
    const plaintext = "Lakers -3.5 (-110)";
    const { ciphertext, iv } = await encrypt(plaintext, key);

    // Reconstruct key from 3 shares
    const reconstructedVal = reconstructSecret(shares.slice(0, 3));
    const reconstructedKey = bigIntToKey(reconstructedVal);

    // Decrypt with reconstructed key
    const decrypted = await decrypt(ciphertext, iv, reconstructedKey);
    expect(decrypted).toBe(plaintext);
  });
});
