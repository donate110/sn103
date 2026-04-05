import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Must mock fetch before importing the route
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocking
import { GET } from "../route";

function makeRequest(
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): NextRequest {
  const url = new URL("http://localhost:3000/api/odds");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url, { headers });
}

describe("GET /api/odds", () => {
  beforeEach(() => {
    vi.stubEnv("ODDS_API_KEY", "test-key-123");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- Missing API key ---

  it("returns 503 when ODDS_API_KEY is not set", async () => {
    vi.stubEnv("ODDS_API_KEY", "");
    const resp = await GET(makeRequest({ sport: "basketball_nba" }));
    expect(resp.status).toBe(503);
    const body = await resp.json();
    expect(body.error).toContain("ODDS_API_KEY");
  });

  // --- Input validation ---

  it("returns 400 for missing sport param", async () => {
    const resp = await GET(makeRequest({}));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Invalid sport");
  });

  it("returns 400 for invalid sport param", async () => {
    const resp = await GET(makeRequest({ sport: "curling" }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Invalid sport");
  });

  it("returns 400 for invalid markets param", async () => {
    const resp = await GET(
      makeRequest({ sport: "basketball_nba", markets: "invalid_market" }),
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("No valid markets");
  });

  it("filters out invalid markets and keeps valid ones", async () => {
    const mockData = [{ id: "event1" }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    // Use a unique sport to avoid cache collisions from other tests
    const resp = await GET(
      makeRequest({
        sport: "soccer_epl",
        markets: "spreads,invalid,h2h",
      }),
    );
    expect(resp.status).toBe(200);

    // Verify the fetch URL only contains valid markets
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(fetchUrl.searchParams.get("markets")).toBe("spreads,h2h");
  });

  // --- Successful fetch ---

  it("returns data from upstream API", async () => {
    const mockData = [{ id: "event1", sport_key: "basketball_ncaab" }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    const resp = await GET(makeRequest({ sport: "basketball_ncaab" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual(mockData);
  });

  it("passes correct params to upstream API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await GET(
      makeRequest({ sport: "americanfootball_nfl", markets: "h2h" }),
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(fetchUrl.pathname).toBe("/v4/sports/americanfootball_nfl/odds");
    expect(fetchUrl.searchParams.get("apiKey")).toBe("test-key-123");
    expect(fetchUrl.searchParams.get("regions")).toBe("us");
    expect(fetchUrl.searchParams.get("markets")).toBe("h2h");
    expect(fetchUrl.searchParams.get("oddsFormat")).toBe("decimal");
  });

  it("sends commenceTimeFrom without milliseconds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await GET(makeRequest({ sport: "soccer_france_ligue_one" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = new URL(mockFetch.mock.calls[0][0]);
    const dateParam = fetchUrl.searchParams.get("commenceTimeFrom")!;
    // Must end with Z, must NOT contain milliseconds (e.g. .000Z)
    expect(dateParam).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("uses default markets when not specified", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    // Use a unique sport to ensure no cache collision
    await GET(makeRequest({ sport: "americanfootball_ncaaf" }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(fetchUrl.searchParams.get("markets")).toBe("spreads,totals,h2h");
  });

  // --- Upstream errors ---

  it("returns 502 when upstream API returns non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
      statusText: "Internal Server Error",
    });

    // Use a unique sport to avoid hitting cache
    const resp = await GET(
      makeRequest({ sport: "mma_mixed_martial_arts" }),
    );
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toContain("Odds provider returned an error");
  });

  it("returns 502 when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

    // Use a unique sport to avoid hitting cache
    const resp = await GET(
      makeRequest({ sport: "soccer_spain_la_liga" }),
    );
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.error).toContain("Failed to fetch odds from provider");
  });

  // --- Caching ---

  it("returns cached data on second request", async () => {
    const mockData = [{ id: "cached-event" }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    // Use unique sport for cache test
    const resp1 = await GET(makeRequest({ sport: "baseball_mlb" }));
    expect(resp1.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second request — should use cache (mock is exhausted after 1 call)
    const resp2 = await GET(makeRequest({ sport: "baseball_mlb" }));
    expect(resp2.status).toBe(200);
    const body = await resp2.json();
    expect(body).toEqual(mockData);
    // fetch should NOT have been called again
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // --- All allowed sports accepted ---

  it.each([
    "basketball_nba",
    "soccer_germany_bundesliga",
    "soccer_italy_serie_a",
    "soccer_france_ligue_one",
    "soccer_uefa_champs_league",
    "soccer_usa_mls",
    "golf_pga_championship_winner",
    "boxing_boxing",
  ])("accepts sport=%s", async (sport) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const resp = await GET(makeRequest({ sport }));
    // Accept 200 (fresh or cached)
    expect(resp.status).toBe(200);
  });

  // --- All allowed markets accepted ---

  it.each(["spreads", "totals", "h2h"])("accepts market=%s", async (market) => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    // Use unique sport per market to avoid cache collisions
    const sport =
      market === "spreads"
        ? "tennis_atp_french_open"
        : market === "totals"
          ? "icehockey_nhl"
          : "basketball_nba";
    const resp = await GET(makeRequest({ sport, markets: market }));
    expect(resp.status).toBe(200);
  });

  // --- Rate limiting ---

  it("returns 429 after exceeding rate limit", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    // Use a unique IP to avoid collisions with other tests
    const headers = { "x-forwarded-for": "192.168.99.99" };

    // Send 120 requests (the limit)
    for (let i = 0; i < 120; i++) {
      const resp = await GET(
        makeRequest({ sport: "icehockey_nhl" }, headers),
      );
      expect(resp.status).toBe(200);
    }

    // 121st request should be rate limited
    const resp = await GET(
      makeRequest({ sport: "icehockey_nhl" }, headers),
    );
    expect(resp.status).toBe(429);
    const body = await resp.json();
    expect(body.error).toContain("Too many requests");
  });

  it("uses x-real-ip when x-forwarded-for is absent", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const headers = { "x-real-ip": "10.0.0.99" };
    const resp = await GET(
      makeRequest({ sport: "basketball_nba" }, headers),
    );
    expect(resp.status).toBe(200);
  });
});

describe("GET /api/health", () => {
  it("returns ok status", async () => {
    const { GET: healthGet } = await import("../../health/route");
    const resp = await healthGet();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(body.timestamp).toBeDefined();
  });
});
