import { describe, it, expect } from "vitest";
import { encryptSignal } from "./signal";
import { reconstructSecret, bigIntToKey, decrypt } from "./crypto";
import type { ShamirShare } from "./crypto";

const mockValidators = [
  { uid: 1, pubkey: "0xaaa" },
  { uid: 2, pubkey: "0xbbb" },
  { uid: 3, pubkey: "0xccc" },
];

const mockPick = {
  event_id: "evt_123",
  market: "spreads",
  pick: "Celtics -4.5",
  odds: -110,
  bookmaker: "DraftKings",
};

const mockDecoys = Array.from({ length: 9 }, (_, i) => ({
  event_id: `evt_${i + 200}`,
  market: "spreads",
  pick: `Team${i} ${i % 2 === 0 ? "+" : "-"}${i + 1}.5`,
  odds: -110,
  bookmaker: "FanDuel",
}));

describe("encryptSignal", () => {
  it("produces encrypted output with correct structure", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    expect(result.blob).toBeTruthy();
    expect(result.iv).toBeTruthy();
    expect(result.hash).toBeTruthy();
    expect(result.realIndex).toBeGreaterThanOrEqual(1);
    expect(result.realIndex).toBeLessThanOrEqual(10);
    expect(result.shares).toHaveLength(3);
    expect(result.localKey).toHaveLength(32);
  });

  it("produces shares for each validator", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    for (const share of result.shares) {
      expect(share.validatorUid).toBeGreaterThan(0);
      expect(share.keyShare).toHaveLength(64);
      expect(share.indexShare).toHaveLength(64);
      expect(share.shareX).toBeGreaterThan(0);
    }
  });

  it("can decrypt the blob with the local key", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    const decrypted = await decrypt(result.blob, result.iv, result.localKey);
    const lines = JSON.parse(decrypted);
    expect(lines).toHaveLength(10);

    // The real pick should be at realIndex - 1 (0-indexed)
    const realLine = lines[result.realIndex - 1];
    expect(realLine.pick).toBe("Celtics -4.5");
    expect(realLine.event_id).toBe("evt_123");
  });

  it("can reconstruct the key from Shamir shares", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    // Reconstruct key from 2 shares
    const shares: ShamirShare[] = result.shares.slice(0, 2).map((s) => ({
      x: s.shareX,
      y: BigInt("0x" + s.keyShare),
    }));

    const keyVal = reconstructSecret(shares);
    const key = bigIntToKey(keyVal);

    // Decrypt with reconstructed key
    const decrypted = await decrypt(result.blob, result.iv, key);
    const lines = JSON.parse(decrypted);
    expect(lines).toHaveLength(10);
  });

  it("can reconstruct the real index from Shamir shares", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    // Reconstruct index from 2 shares
    const indexShares: ShamirShare[] = result.shares.slice(0, 2).map((s) => ({
      x: s.shareX,
      y: BigInt("0x" + s.indexShare),
    }));

    const indexVal = reconstructSecret(indexShares);
    expect(Number(indexVal)).toBe(result.realIndex);
  });

  it("blob does not contain plaintext pick", async () => {
    const result = await encryptSignal({
      pick: mockPick,
      decoys: mockDecoys,
      validators: mockValidators,
      shamirK: 2,
    });

    // The hex-encoded ciphertext should not contain any readable pick data
    expect(result.blob).not.toContain("Celtics");
    expect(result.blob).not.toContain("evt_123");
  });

  it("throws for wrong number of decoys", async () => {
    await expect(
      encryptSignal({
        pick: mockPick,
        decoys: mockDecoys.slice(0, 5),
        validators: mockValidators,
        shamirK: 2,
      }),
    ).rejects.toThrow("Expected 9 decoys");
  });

  it("randomizes the real pick position", async () => {
    const positions = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const result = await encryptSignal({
        pick: mockPick,
        decoys: mockDecoys,
        validators: mockValidators,
        shamirK: 2,
      });
      positions.add(result.realIndex);
    }
    // With 20 attempts and 10 possible positions, we should see at least 3 different positions
    expect(positions.size).toBeGreaterThanOrEqual(3);
  });
});
