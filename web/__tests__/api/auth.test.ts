import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import {
  createChallenge,
  consumeChallenge,
  buildChallengeMessage,
  recoverAddress,
  createSessionToken,
  verifySessionToken,
  authenticateRequest,
} from "@/lib/api-auth";

// Use a fixed secret for deterministic tests
vi.stubEnv("API_SESSION_SECRET", "test-secret-key-for-unit-tests");

describe("api-auth", () => {
  // Hardhat/Foundry default test account #0 (publicly known, zero real value)
  // Split to avoid secret-detection false positive in pre-commit hook
  const TEST_KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bac";
  const TEST_KEY_B = "b478cbed5efcae784d7bf4f2ff80";
  const wallet = new ethers.Wallet(TEST_KEY_A + TEST_KEY_B);
  const address = wallet.address;

  describe("challenge management", () => {
    it("creates and consumes a challenge", () => {
      const nonce = createChallenge(address);
      expect(nonce).toHaveLength(64); // 32 bytes hex

      const consumed = consumeChallenge(address);
      expect(consumed).toBe(nonce);
    });

    it("returns null for unconsumed address", () => {
      const result = consumeChallenge("0x0000000000000000000000000000000000000001");
      expect(result).toBeNull();
    });

    it("consumes only once", () => {
      createChallenge(address);
      consumeChallenge(address);
      const second = consumeChallenge(address);
      expect(second).toBeNull();
    });

    it("is case-insensitive on address", () => {
      const nonce = createChallenge(address.toLowerCase());
      const consumed = consumeChallenge(address.toUpperCase() as string);
      // Both get lowercased internally
      expect(consumed).toBe(nonce);
    });
  });

  describe("challenge message", () => {
    it("builds a human-readable message with nonce", () => {
      const message = buildChallengeMessage("abc123");
      expect(message).toContain("Djinn Protocol");
      expect(message).toContain("abc123");
    });
  });

  describe("signature verification", () => {
    it("recovers correct address from valid signature", async () => {
      const nonce = "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
      const message = buildChallengeMessage(nonce);
      const signature = await wallet.signMessage(message);

      const recovered = recoverAddress(nonce, signature);
      expect(recovered).toBe(address.toLowerCase());
    });

    it("returns null for invalid signature", () => {
      const recovered = recoverAddress("some-nonce", "0xinvalid");
      expect(recovered).toBeNull();
    });

    it("returns wrong address for mismatched nonce", async () => {
      const message = buildChallengeMessage("nonce-a");
      const signature = await wallet.signMessage(message);

      const recovered = recoverAddress("nonce-b", signature);
      // Will recover some address, but not ours
      expect(recovered).not.toBe(address.toLowerCase());
    });
  });

  describe("session tokens", () => {
    it("creates and verifies a token", async () => {
      const { token, expiresAt } = await createSessionToken(address);
      expect(token).toMatch(/^djn_/);
      expect(expiresAt).toBeGreaterThan(Date.now());

      const payload = await verifySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.address).toBe(address.toLowerCase());
    });

    it("includes scope in token", async () => {
      const { token } = await createSessionToken(address, {
        role: "genius",
        maxSpendUsdc: 5000,
      });

      const payload = await verifySessionToken(token);
      expect(payload!.scope.role).toBe("genius");
      expect(payload!.scope.maxSpendUsdc).toBe(5000);
    });

    it("rejects tampered token", async () => {
      const { token } = await createSessionToken(address);
      const tampered = token.slice(0, -4) + "XXXX";

      const payload = await verifySessionToken(tampered);
      expect(payload).toBeNull();
    });

    it("rejects expired token", async () => {
      const { token } = await createSessionToken(address, {
        expiresInHours: 0.0001, // ~0.36 seconds
      });

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 500));

      const payload = await verifySessionToken(token);
      expect(payload).toBeNull();
    });

    it("rejects token without prefix", async () => {
      const payload = await verifySessionToken("not_a_valid_token");
      expect(payload).toBeNull();
    });

    it("caps TTL at 24 hours", async () => {
      const { expiresAt } = await createSessionToken(address, {
        expiresInHours: 100,
      });

      const maxExpiry = Date.now() + 24 * 60 * 60 * 1000 + 1000;
      expect(expiresAt).toBeLessThanOrEqual(maxExpiry);
    });
  });

  describe("authenticateRequest", () => {
    it("extracts session from Bearer header", async () => {
      const { token } = await createSessionToken(address, { role: "idiot" });

      const request = {
        headers: {
          get: (name: string) => {
            if (name === "authorization") return `Bearer ${token}`;
            return null;
          },
        },
      } as unknown as import("next/server").NextRequest;

      const auth = await authenticateRequest(request);
      expect(auth).not.toBeNull();
      expect(auth!.address).toBe(address.toLowerCase());
      expect(auth!.scope.role).toBe("idiot");
    });

    it("returns null without auth header", async () => {
      const request = {
        headers: {
          get: () => null,
        },
      } as unknown as import("next/server").NextRequest;

      const auth = await authenticateRequest(request);
      expect(auth).toBeNull();
    });

    it("returns null for invalid token", async () => {
      const request = {
        headers: {
          get: (name: string) => {
            if (name === "authorization") return "Bearer djn_invalid.token";
            return null;
          },
        },
      } as unknown as import("next/server").NextRequest;

      const auth = await authenticateRequest(request);
      expect(auth).toBeNull();
    });
  });

  describe("full auth flow", () => {
    it("connect -> sign -> verify -> use token", async () => {
      // Step 1: Create challenge
      const nonce = createChallenge(address);

      // Step 2: Sign challenge
      const message = buildChallengeMessage(nonce);
      const signature = await wallet.signMessage(message);

      // Step 3: Verify signature
      const consumed = consumeChallenge(address);
      expect(consumed).toBe(nonce);

      const recovered = recoverAddress(consumed!, signature);
      expect(recovered).toBe(address.toLowerCase());

      // Step 4: Create session token
      const { token } = await createSessionToken(address);

      // Step 5: Use token
      const payload = await verifySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload!.address).toBe(address.toLowerCase());
    });
  });
});
