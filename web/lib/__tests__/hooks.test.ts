import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mock the events module
const mockGetActiveSignals = vi.fn();
const mockGetSignalsByGenius = vi.fn();
const mockGetPurchasesByBuyer = vi.fn();
const mockGetAuditsByGenius = vi.fn();

vi.mock("../events", () => ({
  getActiveSignals: (...args: unknown[]) => mockGetActiveSignals(...args),
  getSignalsByGenius: (...args: unknown[]) => mockGetSignalsByGenius(...args),
  getPurchasesByBuyer: (...args: unknown[]) => mockGetPurchasesByBuyer(...args),
  getAuditsByGenius: (...args: unknown[]) => mockGetAuditsByGenius(...args),
}));

// Mock the provider hook
const mockProvider = { getBlockNumber: vi.fn() };
vi.mock("../hooks", async () => {
  const actual = await vi.importActual("../hooks");
  return {
    ...(actual as Record<string, unknown>),
    useEthersProvider: () => mockProvider,
    getReadProvider: () => mockProvider,
  };
});

import { useActiveSignals } from "../hooks/useSignals";
import { usePurchaseHistory } from "../hooks/usePurchaseHistory";
import { useAuditHistory } from "../hooks/useAuditHistory";
import type { SignalEvent, PurchaseEvent, AuditEvent } from "../events";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// useActiveSignals
// ---------------------------------------------------------------------------

describe("useActiveSignals", () => {
  const mockSignals: SignalEvent[] = [
    {
      signalId: "1",
      genius: "0xGenius1",
      sport: "basketball_nba",
      maxPriceBps: 500n,
      slaMultiplierBps: 200n,
      maxNotional: 10000_000000n,
      minNotional: 0n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      blockNumber: 100,
    },
    {
      signalId: "2",
      genius: "0xGenius2",
      sport: "football_nfl",
      maxPriceBps: 300n,
      slaMultiplierBps: 150n,
      maxNotional: 5000_000000n,
      minNotional: 0n,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 7200),
      blockNumber: 200,
    },
  ];

  it("fetches active signals on mount", async () => {
    mockGetActiveSignals.mockResolvedValueOnce(mockSignals);

    const { result } = renderHook(() => useActiveSignals());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signals).toHaveLength(2);
    expect(result.current.error).toBeNull();
    expect(mockGetActiveSignals).toHaveBeenCalledWith(mockProvider);
  });

  it("filters by sport", async () => {
    mockGetActiveSignals.mockResolvedValueOnce(mockSignals);

    const { result } = renderHook(() => useActiveSignals("basketball_nba"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.signals).toHaveLength(1);
    expect(result.current.signals[0].sport).toBe("basketball_nba");
  });

  it("fetches by genius address when provided", async () => {
    mockGetSignalsByGenius.mockResolvedValueOnce([mockSignals[0]]);

    const { result } = renderHook(() =>
      useActiveSignals(undefined, "0xGenius1"),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockGetSignalsByGenius).toHaveBeenCalledWith(
      mockProvider,
      "0xGenius1",
      undefined,
      false,
    );
    expect(result.current.signals).toHaveLength(1);
  });

  it("handles fetch error", async () => {
    mockGetActiveSignals.mockRejectedValueOnce(new Error("RPC error"));

    const { result } = renderHook(() => useActiveSignals());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("RPC error");
    expect(result.current.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// usePurchaseHistory
// ---------------------------------------------------------------------------

describe("usePurchaseHistory", () => {
  const mockPurchases: PurchaseEvent[] = [
    {
      purchaseId: "p-1",
      signalId: "1",
      buyer: "0xBuyer",
      notional: 1000000n,
      feePaid: 50000n,
      creditUsed: 0n,
      usdcPaid: 1050000n,
      blockNumber: 150,
    },
  ];

  it("fetches purchases for a buyer address", async () => {
    mockGetPurchasesByBuyer.mockResolvedValueOnce(mockPurchases);

    const { result } = renderHook(() => usePurchaseHistory("0xBuyer"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.purchases).toHaveLength(1);
    expect(result.current.purchases[0].buyer).toBe("0xBuyer");
    expect(result.current.error).toBeNull();
  });

  it("does not fetch without buyer address", async () => {
    const { result } = renderHook(() => usePurchaseHistory(undefined));

    // Should not start loading when no address
    expect(result.current.loading).toBe(false);
    expect(result.current.purchases).toHaveLength(0);
    expect(mockGetPurchasesByBuyer).not.toHaveBeenCalled();
  });

  it("handles fetch error", async () => {
    mockGetPurchasesByBuyer.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => usePurchaseHistory("0xBuyer"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
  });
});

// ---------------------------------------------------------------------------
// useAuditHistory
// ---------------------------------------------------------------------------

describe("useAuditHistory", () => {
  const mockAudits: AuditEvent[] = [
    {
      genius: "0xGenius",
      idiot: "0xIdiot",
      cycle: 1n,
      qualityScore: 8500n,
      trancheA: 100000n,
      trancheB: 50000n,
      protocolFee: 2500n,
      isEarlyExit: false,
      blockNumber: 300,
    },
    {
      genius: "0xGenius",
      idiot: "0xIdiot2",
      cycle: 2n,
      qualityScore: 7000n,
      trancheA: 80000n,
      trancheB: 40000n,
      protocolFee: 2000n,
      isEarlyExit: false,
      blockNumber: 400,
    },
  ];

  it("fetches audit history for a genius", async () => {
    mockGetAuditsByGenius.mockResolvedValueOnce(mockAudits);

    const { result } = renderHook(() => useAuditHistory("0xGenius"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.audits).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("computes aggregate quality score", async () => {
    mockGetAuditsByGenius.mockResolvedValueOnce(mockAudits);

    const { result } = renderHook(() => useAuditHistory("0xGenius"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // 8500n + 7000n = 15500n
    expect(result.current.aggregateQualityScore).toBe(15500n);
  });

  it("does not fetch without genius address", async () => {
    const { result } = renderHook(() => useAuditHistory(undefined));

    expect(result.current.loading).toBe(false);
    expect(result.current.audits).toHaveLength(0);
    expect(mockGetAuditsByGenius).not.toHaveBeenCalled();
  });

  it("handles fetch error", async () => {
    mockGetAuditsByGenius.mockRejectedValueOnce(new Error("Contract error"));

    const { result } = renderHook(() => useAuditHistory("0xGenius"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Contract error");
  });

  it("returns zero aggregate for empty audits", async () => {
    mockGetAuditsByGenius.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useAuditHistory("0xGenius"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.aggregateQualityScore).toBe(0n);
  });
});
