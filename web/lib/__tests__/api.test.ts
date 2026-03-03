import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidatorClient, MinerClient, ApiError } from "../api";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// ValidatorClient
// ---------------------------------------------------------------------------

describe("ValidatorClient", () => {
  const client = new ValidatorClient("http://localhost:8421");

  describe("storeShare", () => {
    it("sends POST to /v1/signal with correct payload", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ signal_id: "abc123", stored: true }),
      );

      const result = await client.storeShare({
        signal_id: "abc123",
        genius_address: "0xGenius",
        share_x: 1,
        share_y: "0a1b2c",
        encrypted_key_share: "deadbeef",
        encrypted_index_share: "aabbcc",
        shamir_threshold: 7,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8421/v1/signal",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signal_id: "abc123",
            genius_address: "0xGenius",
            share_x: 1,
            share_y: "0a1b2c",
            encrypted_key_share: "deadbeef",
            encrypted_index_share: "aabbcc",
            shamir_threshold: 7,
          }),
        }),
      );

      expect(result.signal_id).toBe("abc123");
      expect(result.stored).toBe(true);
    });

    it("throws on HTTP error after retries for 5xx", async () => {
      // 5xx errors are retried (MAX_RETRIES=2 → 3 total attempts)
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ detail: "Internal error" }, 500))
        .mockResolvedValueOnce(jsonResponse({ detail: "Internal error" }, 500))
        .mockResolvedValueOnce(jsonResponse({ detail: "Internal error" }, 500));

      await expect(
        client.storeShare({
          signal_id: "x",
          genius_address: "0x1",
          share_x: 1,
          share_y: "aa",
          encrypted_key_share: "bb",
          encrypted_index_share: "cc",
          shamir_threshold: 7,
        }),
      ).rejects.toThrow("500");
    });
  });

  describe("purchaseSignal", () => {
    it("sends POST to /v1/signal/{id}/purchase", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          signal_id: "sig1",
          status: "complete",
          available: true,
          encrypted_key_share: "cafe",
          message: "Key share released",
        }),
      );

      const result = await client.purchaseSignal("sig1", {
        buyer_address: "0xBuyer",
        sportsbook: "DraftKings",
        available_indices: [1, 3, 5],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8421/v1/signal/sig1/purchase",
        expect.objectContaining({ method: "POST" }),
      );

      expect(result.status).toBe("complete");
      expect(result.available).toBe(true);
      expect(result.encrypted_key_share).toBe("cafe");
    });

    it("handles unavailable response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          signal_id: "sig1",
          status: "unavailable",
          available: false,
          encrypted_key_share: null,
          message: "Signal not available",
        }),
      );

      const result = await client.purchaseSignal("sig1", {
        buyer_address: "0xBuyer",
        sportsbook: "FanDuel",
        available_indices: [2],
      });

      expect(result.available).toBe(false);
      expect(result.encrypted_key_share).toBeNull();
    });
  });

  describe("health", () => {
    it("sends GET to /health", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          version: "0.1.0",
          uid: null,
          shares_held: 5,
          chain_connected: false,
          bt_connected: false,
        }),
      );

      const result = await client.health();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8421/health",
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(result.status).toBe("ok");
      expect(result.shares_held).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// MinerClient
// ---------------------------------------------------------------------------

describe("MinerClient", () => {
  const client = new MinerClient("http://localhost:8422");

  describe("checkLines", () => {
    it("sends POST to /v1/check with candidate lines", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          results: [
            { index: 1, available: true, bookmakers: [{ bookmaker: "DraftKings", odds: 1.91 }] },
            { index: 2, available: false, bookmakers: [] },
          ],
          available_indices: [1],
          response_time_ms: 42.5,
        }),
      );

      const result = await client.checkLines({
        lines: [
          {
            index: 1,
            sport: "basketball_nba",
            event_id: "evt1",
            home_team: "Lakers",
            away_team: "Celtics",
            market: "spreads",
            line: -3.5,
            side: "Lakers",
          },
          {
            index: 2,
            sport: "basketball_nba",
            event_id: "evt1",
            home_team: "Lakers",
            away_team: "Celtics",
            market: "spreads",
            line: -5.5,
            side: "Lakers",
          },
        ],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8422/v1/check",
        expect.objectContaining({ method: "POST" }),
      );

      expect(result.available_indices).toEqual([1]);
      expect(result.results[0].available).toBe(true);
      expect(result.results[0].bookmakers[0].bookmaker).toBe("DraftKings");
    });

    it("throws on client error (no retry for 4xx)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ detail: "bad request" }, 400),
      );

      await expect(
        client.checkLines({ lines: [] }),
      ).rejects.toThrow("400");
    });
  });

  describe("health", () => {
    it("sends GET to /health", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: "ok",
          version: "0.1.0",
          uid: 7,
          odds_api_connected: true,
          bt_connected: false,
          uptime_seconds: 3600,
        }),
      );

      const result = await client.health();
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8422/health",
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(result.uid).toBe(7);
      expect(result.odds_api_connected).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("includes status code in error message", async () => {
    const client = new ValidatorClient("http://localhost:8421");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: "not found" }, 404),
    );
    await expect(client.health()).rejects.toThrow("404");
  });

  it("propagates network errors after retries", async () => {
    const client = new MinerClient("http://localhost:8422");
    // Network errors (TypeError) are retried
    mockFetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.health()).rejects.toThrow("Failed to fetch");
  });

  it("wraps abort errors as timeout (no retry)", async () => {
    const client = new MinerClient("http://localhost:8422");
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);
    await expect(client.health()).rejects.toThrow("timed out");
    // Timeout should NOT be retried — only 1 fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry 4xx errors", async () => {
    const client = new ValidatorClient("http://localhost:8421");
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "not found" }, 404));
    await expect(client.health()).rejects.toThrow("404");
    // 4xx should NOT be retried — only 1 fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries then succeeds on transient 500", async () => {
    const client = new ValidatorClient("http://localhost:8421");
    // First call 500, second call succeeds
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ detail: "error" }, 500))
      .mockResolvedValueOnce(
        jsonResponse({ status: "ok", version: "0.1.0", uid: null, shares_held: 0, chain_connected: false, bt_connected: false }),
      );

    const result = await client.health();
    expect(result.status).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("ApiError has correct properties", () => {
    const err = new ApiError(503, "Service unavailable", "http://test");
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.rateLimited).toBe(false);
    expect(err.name).toBe("ApiError");

    const rateLimited = new ApiError(429, "Too many requests", "http://test");
    expect(rateLimited.rateLimited).toBe(true);
    expect(rateLimited.retryable).toBe(false);
  });
});
