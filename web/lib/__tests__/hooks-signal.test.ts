import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mock contracts module
const mockGetSignal = vi.fn();
vi.mock("../contracts", () => ({
  getSignalCommitmentContract: () => ({
    getSignal: mockGetSignal,
  }),
  getEscrowContract: () => ({}),
  getCollateralContract: () => ({}),
  getCreditLedgerContract: () => ({}),
  getUsdcContract: () => ({}),
  ADDRESSES: {
    signalCommitment: "0x1111111111111111111111111111111111111111",
    escrow: "0x2222222222222222222222222222222222222222",
    collateral: "0x3333333333333333333333333333333333333333",
    creditLedger: "0x4444444444444444444444444444444444444444",
    usdc: "0x5555555555555555555555555555555555555555",
    account: "0x6666666666666666666666666666666666666666",
    trackRecord: "0x7777777777777777777777777777777777777777",
  },
}));

// Mock wagmi
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0xTestAddress", isConnected: true }),
  useWalletClient: () => ({ data: null }),
}));

// Mock app/providers
vi.mock("../../app/providers", () => ({
  wagmiConfig: {},
}));

// Mock provider
const mockProvider = { getBlockNumber: vi.fn() };
vi.mock("../hooks", async () => {
  const actual = await vi.importActual("../hooks");
  return {
    ...(actual as Record<string, unknown>),
    useEthersProvider: () => mockProvider,
    getReadProvider: () => mockProvider,
  };
});

import { useSignal } from "../hooks";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSignal", () => {
  const mockRawSignal = {
    genius: "0xGenius1",
    encryptedBlob: "0xabcdef",
    commitHash: "0x123456",
    sport: "basketball_nba",
    maxPriceBps: 500n,
    slaMultiplierBps: 10000n,
    maxNotional: 10000000000n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    decoyLines: ["line1", "line2"],
    availableSportsbooks: ["DraftKings", "FanDuel"],
    status: 0,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
  };

  it("fetches a signal by ID", async () => {
    mockGetSignal.mockResolvedValueOnce(mockRawSignal);

    const { result } = renderHook(() => useSignal(42n));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signal).not.toBeNull();
    expect(result.current.signal!.genius).toBe("0xGenius1");
    expect(result.current.signal!.sport).toBe("basketball_nba");
    expect(result.current.signal!.maxPriceBps).toBe(500n);
    expect(result.current.signal!.decoyLines).toEqual(["line1", "line2"]);
    expect(result.current.error).toBeNull();
    expect(mockGetSignal).toHaveBeenCalledWith(42n);
  });

  it("returns null when signalId is undefined", () => {
    const { result } = renderHook(() => useSignal(undefined));

    expect(result.current.signal).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockGetSignal).not.toHaveBeenCalled();
  });

  it("handles fetch error", async () => {
    mockGetSignal.mockRejectedValueOnce(new Error("Signal not found"));

    const { result } = renderHook(() => useSignal(1n));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signal).toBeNull();
    expect(result.current.error).toBe("Signal not found");
  });

  it("converts numeric fields to bigint", async () => {
    mockGetSignal.mockResolvedValueOnce({
      ...mockRawSignal,
      maxPriceBps: 300, // number, not bigint
      slaMultiplierBps: "15000", // string, not bigint
    });

    const { result } = renderHook(() => useSignal(1n));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signal!.maxPriceBps).toBe(300n);
    expect(result.current.signal!.slaMultiplierBps).toBe(15000n);
  });

  it("handles missing fields gracefully", async () => {
    mockGetSignal.mockResolvedValueOnce({
      genius: "0xGenius",
      sport: "NFL",
      // All other fields missing
    });

    const { result } = renderHook(() => useSignal(1n));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signal).not.toBeNull();
    expect(result.current.signal!.genius).toBe("0xGenius");
    expect(result.current.signal!.encryptedBlob).toBe("");
    expect(result.current.signal!.maxPriceBps).toBe(0n);
    expect(result.current.signal!.decoyLines).toEqual([]);
  });

  it("cancels on unmount", async () => {
    let resolveSignal: (v: unknown) => void;
    mockGetSignal.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignal = resolve;
      }),
    );

    const { unmount, result } = renderHook(() => useSignal(1n));
    expect(result.current.loading).toBe(true);

    // Unmount before the promise resolves
    unmount();

    // Resolve after unmount — should not throw
    resolveSignal!(mockRawSignal);

    // No state update should happen (would cause React warning if it did)
    await new Promise((r) => setTimeout(r, 50));
  });
});
