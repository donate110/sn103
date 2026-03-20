import { describe, it, expect } from "vitest";
import {
  deriveRecoveryKey,
  encryptRecoveryBlob,
  decryptRecoveryBlob,
} from "../recovery";
import type { SavedSignalData } from "../hooks/useSettledSignals";
import type { PurchasedSignalData } from "../preferences";

const MOCK_SIGNATURE =
  "0x" + "ab".repeat(65); // 65 bytes like a real ECDSA signature

const MOCK_SIGNALS: SavedSignalData[] = [
  {
    signalId: "12345",
    preimage: "98765432109876543210",
    realIndex: 3,
    sport: "NBA",
    pick: "Lakers -3.5",
    minOdds: 1.91,
    minOddsAmerican: "-110",
    slaMultiplierBps: 15000,
    createdAt: 1708300000,
  },
  {
    signalId: "67890",
    preimage: "11111111111111111111",
    realIndex: 7,
    sport: "NFL",
    pick: "Chiefs +2.5",
    slaMultiplierBps: 20000,
    createdAt: 1708400000,
  },
];

describe("deriveRecoveryKey", () => {
  it("produces a 32-byte key", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("produces the same key for the same signature", async () => {
    const key1 = await deriveRecoveryKey(MOCK_SIGNATURE);
    const key2 = await deriveRecoveryKey(MOCK_SIGNATURE);
    expect(key1).toEqual(key2);
  });

  it("produces different keys for different signatures", async () => {
    const key1 = await deriveRecoveryKey(MOCK_SIGNATURE);
    const key2 = await deriveRecoveryKey("0x" + "cd".repeat(65));
    expect(key1).not.toEqual(key2);
  });

  it("handles signatures without 0x prefix", async () => {
    const withPrefix = await deriveRecoveryKey(MOCK_SIGNATURE);
    const withoutPrefix = await deriveRecoveryKey(MOCK_SIGNATURE.slice(2));
    expect(withPrefix).toEqual(withoutPrefix);
  });
});

const MOCK_PURCHASES: PurchasedSignalData[] = [
  {
    signalId: "55555",
    realIndex: 2,
    pick: "Celtics +4.5",
    sportsbook: "FanDuel",
    notional: "500",
    purchasedAt: 1708350000,
  },
];

describe("encrypt/decrypt recovery blob roundtrip", () => {
  it("encrypts and decrypts signal data (v1)", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const blob = await encryptRecoveryBlob(MOCK_SIGNALS, key);
    expect(blob.constructor.name).toBe("Uint8Array");
    expect(blob.length).toBeGreaterThan(0);

    const recovered = await decryptRecoveryBlob(blob, key);
    expect(recovered.signals).toEqual(MOCK_SIGNALS);
    expect(recovered.purchases).toEqual([]);
  });

  it("encrypts and decrypts signals + purchases (v2)", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const blob = await encryptRecoveryBlob(MOCK_SIGNALS, key, MOCK_PURCHASES);
    const recovered = await decryptRecoveryBlob(blob, key);
    expect(recovered.signals).toEqual(MOCK_SIGNALS);
    expect(recovered.purchases).toEqual(MOCK_PURCHASES);
  });

  it("v2 with empty purchases falls back to v1 format", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const blob = await encryptRecoveryBlob(MOCK_SIGNALS, key, []);
    const recovered = await decryptRecoveryBlob(blob, key);
    expect(recovered.signals).toEqual(MOCK_SIGNALS);
    expect(recovered.purchases).toEqual([]);
  });

  it("fails to decrypt with wrong key", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const wrongKey = await deriveRecoveryKey("0x" + "ff".repeat(65));
    const blob = await encryptRecoveryBlob(MOCK_SIGNALS, key);

    await expect(decryptRecoveryBlob(blob, wrongKey)).rejects.toThrow();
  });

  it("handles empty signal array", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const blob = await encryptRecoveryBlob([], key);
    const recovered = await decryptRecoveryBlob(blob, key);
    expect(recovered.signals).toEqual([]);
    expect(recovered.purchases).toEqual([]);
  });

  it("rejects invalid blob format", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const badBlob = new TextEncoder().encode("no-colon-separator");
    await expect(decryptRecoveryBlob(badBlob, key)).rejects.toThrow(
      "Recovery blob is corrupted",
    );
  });

  it("blob fits within 4KB for reasonable usage", async () => {
    const key = await deriveRecoveryKey(MOCK_SIGNATURE);
    const signals = Array.from({ length: 8 }, (_, i) => ({
      signalId: String(i),
      preimage: "123456789012345678",
      realIndex: (i % 10) + 1,
      sport: "NBA",
      pick: "Team A -3.5",
      slaMultiplierBps: 15000,
      createdAt: 1708300000 + i,
    }));
    const purchases = Array.from({ length: 4 }, (_, i) => ({
      signalId: String(100 + i),
      realIndex: (i % 10) + 1,
      pick: "Team B +2.5",
      sportsbook: "DraftKings",
      notional: "200",
      purchasedAt: 1708400000 + i,
    }));
    const blob = await encryptRecoveryBlob(signals, key, purchases);
    expect(blob.length).toBeLessThan(4096);
  });
});

describe("localStorage namespacing", () => {
  it("getSavedSignals and saveSavedSignals namespace by address", async () => {
    // Dynamic import to avoid issues with module-level localStorage access
    const { getSavedSignals, saveSavedSignals } = await import(
      "../hooks/useSettledSignals"
    );

    const addr1 = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const addr2 = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    saveSavedSignals(addr1, [MOCK_SIGNALS[0]]);
    saveSavedSignals(addr2, [MOCK_SIGNALS[1]]);

    const data1 = getSavedSignals(addr1);
    const data2 = getSavedSignals(addr2);

    expect(data1).toHaveLength(1);
    expect(data1[0].signalId).toBe("12345");
    expect(data2).toHaveLength(1);
    expect(data2[0].signalId).toBe("67890");

    // Without address returns empty
    expect(getSavedSignals()).toEqual([]);
    expect(getSavedSignals(undefined)).toEqual([]);

    // Cleanup
    localStorage.removeItem(`djinn-signal-data:${addr1.toLowerCase()}`);
    localStorage.removeItem(`djinn-signal-data:${addr2.toLowerCase()}`);
  });

  it("migrates legacy non-namespaced data", async () => {
    const { getSavedSignals } = await import("../hooks/useSettledSignals");
    const addr = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

    // Write legacy (non-namespaced) data
    localStorage.setItem("djinn-signal-data", JSON.stringify([MOCK_SIGNALS[0]]));

    // Reading with address should migrate
    const data = getSavedSignals(addr);
    expect(data).toHaveLength(1);
    expect(data[0].signalId).toBe("12345");

    // Legacy key should be removed
    expect(localStorage.getItem("djinn-signal-data")).toBeNull();
    // Namespaced key should exist
    expect(localStorage.getItem(`djinn-signal-data:${addr.toLowerCase()}`)).not.toBeNull();

    // Cleanup
    localStorage.removeItem(`djinn-signal-data:${addr.toLowerCase()}`);
  });
});

describe("sportsbook preferences namespacing", () => {
  it("namespaces by address", async () => {
    const { getSportsbookPrefs, setSportsbookPrefs } = await import(
      "../preferences"
    );

    const addr = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    setSportsbookPrefs(addr, ["DraftKings", "FanDuel"]);

    const prefs = getSportsbookPrefs(addr);
    expect(prefs).toEqual(["DraftKings", "FanDuel"]);

    // Without address returns empty
    expect(getSportsbookPrefs()).toEqual([]);

    // Cleanup
    localStorage.removeItem(`djinn-sportsbook-prefs:${addr.toLowerCase()}`);
  });

  it("migrates legacy prefs", async () => {
    const { getSportsbookPrefs } = await import("../preferences");
    const addr = "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

    localStorage.setItem("djinn-sportsbook-prefs", JSON.stringify(["BetMGM"]));

    const prefs = getSportsbookPrefs(addr);
    expect(prefs).toEqual(["BetMGM"]);
    expect(localStorage.getItem("djinn-sportsbook-prefs")).toBeNull();

    // Cleanup
    localStorage.removeItem(`djinn-sportsbook-prefs:${addr.toLowerCase()}`);
  });
});

describe("purchased signal persistence (idiot side)", () => {
  it("saves and retrieves purchased signals per address", async () => {
    const { getPurchasedSignals, savePurchasedSignal } = await import(
      "../preferences"
    );

    const addr = "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    const purchase = {
      signalId: "99999",
      realIndex: 5,
      pick: "Lakers -3 @ -110",
      sportsbook: "FanDuel",
      notional: "1000",
      purchasedAt: 1708500000,
    };

    savePurchasedSignal(addr, purchase);

    const data = getPurchasedSignals(addr);
    expect(data).toHaveLength(1);
    expect(data[0].signalId).toBe("99999");
    expect(data[0].pick).toBe("Lakers -3 @ -110");

    // Without address returns empty
    expect(getPurchasedSignals()).toEqual([]);
    expect(getPurchasedSignals(undefined)).toEqual([]);

    // Deduplication: saving same signalId again should not duplicate
    savePurchasedSignal(addr, purchase);
    expect(getPurchasedSignals(addr)).toHaveLength(1);

    // Cleanup
    localStorage.removeItem(`djinn-purchased-signals:${addr.toLowerCase()}`);
  });
});
