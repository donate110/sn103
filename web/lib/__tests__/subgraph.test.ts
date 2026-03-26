import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the environment variable before importing the module
vi.stubEnv("NEXT_PUBLIC_SUBGRAPH_URL", "");

describe("subgraph", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("isSubgraphConfigured", () => {
    it("returns false when NEXT_PUBLIC_SUBGRAPH_URL is empty", async () => {
      const { isSubgraphConfigured } = await import("../subgraph");
      expect(isSubgraphConfigured()).toBe(false);
    });
  });

  describe("fetchLeaderboard", () => {
    it("returns empty array when subgraph is not configured", async () => {
      const { fetchLeaderboard } = await import("../subgraph");
      const result = await fetchLeaderboard();
      expect(result).toEqual([]);
    });
  });

  describe("fetchProtocolStats", () => {
    it("returns null when subgraph is not configured", async () => {
      const { fetchProtocolStats } = await import("../subgraph");
      const result = await fetchProtocolStats();
      expect(result).toBeNull();
    });
  });
});
