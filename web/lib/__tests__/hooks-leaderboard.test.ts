import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Mock the subgraph module
const mockFetchLeaderboard = vi.fn();
const mockIsSubgraphConfigured = vi.fn();

vi.mock("../subgraph", () => ({
  fetchLeaderboard: (...args: unknown[]) => mockFetchLeaderboard(...args),
  isSubgraphConfigured: () => mockIsSubgraphConfigured(),
}));

import { useLeaderboard } from "../hooks/useLeaderboard";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useLeaderboard", () => {
  const mockEntries = [
    {
      id: "0xGenius1",
      totalSignals: "10",
      activeSignals: "3",
      totalPurchases: "50",
      totalVolume: "5000000000",       // 5000 USDC (6 decimals)
      totalFeesEarned: "250000000",
      aggregateQualityScore: "8500000000", // 8500 USDC (6 decimals)
      totalAudits: "20",
      collateralDeposited: "1000000000",
      totalSlashed: "0",
    },
    {
      id: "0xGenius2",
      totalSignals: "5",
      activeSignals: "1",
      totalPurchases: "20",
      totalVolume: "2000000000",       // 2000 USDC (6 decimals)
      totalFeesEarned: "100000000",
      aggregateQualityScore: "6000000000", // 6000 USDC (6 decimals)
      totalAudits: "10",
      collateralDeposited: "500000000",
      totalSlashed: "50000000",
    },
  ];

  it("fetches leaderboard when subgraph is configured", async () => {
    mockIsSubgraphConfigured.mockReturnValue(true);
    mockFetchLeaderboard.mockResolvedValueOnce(mockEntries);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data[0].address).toBe("0xGenius1");
    expect(result.current.data[0].qualityScore).toBe(8500);
    expect(result.current.data[0].totalSignals).toBe(10);
    expect(result.current.data[0].auditCount).toBe(20);
    expect(result.current.error).toBeNull();
    expect(result.current.configured).toBe(true);
  });

  it("does not fetch when subgraph is not configured", async () => {
    mockIsSubgraphConfigured.mockReturnValue(false);

    const { result } = renderHook(() => useLeaderboard());

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toHaveLength(0);
    expect(result.current.configured).toBe(false);
    expect(mockFetchLeaderboard).not.toHaveBeenCalled();
  });

  it("handles fetch error", async () => {
    mockIsSubgraphConfigured.mockReturnValue(true);
    mockFetchLeaderboard.mockRejectedValueOnce(new Error("Subgraph down"));

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Subgraph down");
    expect(result.current.data).toHaveLength(0);
  });

  it("computes ROI correctly", async () => {
    mockIsSubgraphConfigured.mockReturnValue(true);
    mockFetchLeaderboard.mockResolvedValueOnce([mockEntries[0]]);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // totalVolume = 5000000000 → 5000 USDC
    // aggregateQualityScore = 8500000000 → 8500 USDC
    // ROI = (8500 / 5000) * 100 = 170
    expect(result.current.data[0].roi).toBe(170);
  });

  it("returns zero ROI when volume is zero", async () => {
    mockIsSubgraphConfigured.mockReturnValue(true);
    mockFetchLeaderboard.mockResolvedValueOnce([
      { ...mockEntries[0], totalVolume: "0" },
    ]);

    const { result } = renderHook(() => useLeaderboard());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data[0].roi).toBe(0);
  });
});
