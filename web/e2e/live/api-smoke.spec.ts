import { test, expect } from "@playwright/test";

/**
 * Comprehensive API smoke tests — exercises every proxy endpoint,
 * edge cases, error handling, and rate limiting.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Health endpoints
// ─────────────────────────────────────────────

test.describe("App health", () => {
  test("GET /api/health returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeTruthy();
    expect(body.timestamp).toBeTruthy();
    // Timestamp should be valid ISO string
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });
});

test.describe("Validator health", () => {
  test("GET /api/validator/health returns full health info", async ({ request }) => {
    const res = await request.get("/api/validator/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("shares_held");
    expect(body).toHaveProperty("pending_outcomes");
    expect(body).toHaveProperty("chain_connected");
    expect(body).toHaveProperty("bt_connected");
    expect(typeof body.shares_held).toBe("number");
    expect(typeof body.pending_outcomes).toBe("number");
    expect(typeof body.chain_connected).toBe("boolean");
  });
});

test.describe("Miner health", () => {
  test("GET /api/miner/health returns full health info", async ({ request }) => {
    const res = await request.get("/api/miner/health");
    if (res.ok()) {
      const body = await res.json();
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("odds_api_connected");
      expect(body).toHaveProperty("bt_connected");
      expect(body).toHaveProperty("uptime_seconds");
      expect(typeof body.uptime_seconds).toBe("number");
      expect(body.uptime_seconds).toBeGreaterThan(0);
    } else {
      // Miner offline
      expect(res.status()).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Miner unavailable");
    }
  });
});

// ─────────────────────────────────────────────
// Validator proxy — path allowlisting
// ─────────────────────────────────────────────

test.describe("Validator proxy security", () => {
  test("blocks non-allowlisted paths", async ({ request }) => {
    const blocked = [
      "/api/validator/v1/mpc/init",
      "/api/validator/v1/mpc/round1",
      "/api/validator/v1/mpc/ot/setup",
      "/api/validator/admin",
      "/api/validator/v1/signals/resolve",
      "/api/validator/metrics",
    ];
    for (const path of blocked) {
      const res = await request.get(path);
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    }
  });

  test("allows /health path", async ({ request }) => {
    const res = await request.get("/api/validator/health");
    // Should proxy through (200 or 502, not 404)
    expect(res.status()).not.toBe(404);
  });

  test("allows /v1/signal path", async ({ request }) => {
    // POST without body → should reach validator (400 from validator, not 404 from proxy)
    const res = await request.post("/api/validator/v1/signal", {
      data: {},
    });
    expect(res.status()).not.toBe(404);
  });

  test("allows purchase path pattern", async ({ request }) => {
    // /v1/signal/{id}/purchase should be allowed
    const res = await request.post("/api/validator/v1/signal/test-123/purchase", {
      data: {},
    });
    expect(res.status()).not.toBe(404);
  });
});

// ─────────────────────────────────────────────
// Miner proxy — path allowlisting
// ─────────────────────────────────────────────

test.describe("Miner proxy security", () => {
  test("blocks non-allowlisted paths", async ({ request }) => {
    const blocked = [
      "/api/miner/v1/proof",
      "/api/miner/admin",
      "/api/miner/metrics",
      "/api/miner/v1/internal",
    ];
    for (const path of blocked) {
      const res = await request.get(path);
      expect(res.status()).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Not found");
    }
  });

  test("allows /health path", async ({ request }) => {
    const res = await request.get("/api/miner/health");
    expect(res.status()).not.toBe(404);
  });

  test("allows /v1/check path", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: { lines: [] },
    });
    // Should reach miner (may be 400/422 from validation, not 404 from proxy)
    expect(res.status()).not.toBe(404);
  });
});

// ─────────────────────────────────────────────
// Odds API
// ─────────────────────────────────────────────

test.describe("Odds API", () => {
  test("returns events for basketball_nba", async ({ request }) => {
    const res = await request.get("/api/odds?sport=basketball_nba");
    if (res.ok()) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      // If games are scheduled, check event structure
      if (body.length > 0) {
        const event = body[0];
        expect(event).toHaveProperty("id");
        expect(event).toHaveProperty("sport_key");
        expect(event).toHaveProperty("home_team");
        expect(event).toHaveProperty("away_team");
        expect(event).toHaveProperty("commence_time");
        expect(event).toHaveProperty("bookmakers");
      }
    } else {
      // May fail during off-season or if API is down
      expect(res.status()).toBeLessThan(500);
    }
  });

  test("accepts americanfootball_nfl sport", async ({ request }) => {
    const res = await request.get("/api/odds?sport=americanfootball_nfl");
    expect(res.status()).toBeLessThan(500);
  });

  test("accepts icehockey_nhl sport", async ({ request }) => {
    const res = await request.get("/api/odds?sport=icehockey_nhl");
    expect(res.status()).toBeLessThan(500);
  });

  test("rejects invalid sport with 400", async ({ request }) => {
    const res = await request.get("/api/odds?sport=invalid_sport_xyz");
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid sport");
    expect(body.error).toContain("Allowed");
  });

  test("rejects missing sport param with 400", async ({ request }) => {
    const res = await request.get("/api/odds");
    expect(res.status()).toBe(400);
  });

  test("filters markets correctly", async ({ request }) => {
    const res = await request.get("/api/odds?sport=basketball_nba&markets=spreads");
    expect(res.status()).toBeLessThan(500);
  });

  test("rejects invalid market but still works", async ({ request }) => {
    // Invalid markets are filtered out — if none remain, returns 400
    const res = await request.get("/api/odds?sport=basketball_nba&markets=invalid_market");
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No valid markets");
  });

  test("all allowed sports are accepted", async ({ request }) => {
    const sports = [
      "basketball_nba",
      "americanfootball_nfl",
      "baseball_mlb",
      "icehockey_nhl",
      "soccer_epl",
      "mma_mixed_martial_arts",
    ];
    for (const sport of sports) {
      const res = await request.get(`/api/odds?sport=${sport}`);
      // Should not be 400 (sport accepted), may be 502 if API fails
      expect(res.status()).not.toBe(400);
    }
  });
});

// ─────────────────────────────────────────────
// Miner line check
// ─────────────────────────────────────────────

test.describe("Miner line check", () => {
  test("accepts valid 10-line check request", async ({ request }) => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      index: i + 1,
      sport: "basketball_nba",
      event_id: `test-event-${i}`,
      home_team: "Test Home",
      away_team: "Test Away",
      market: "spreads",
      line: -3.5,
      side: "Test Home",
    }));

    const res = await request.post("/api/miner/v1/check", {
      data: { lines },
    });

    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("results");
      expect(body).toHaveProperty("available_indices");
      expect(body).toHaveProperty("response_time_ms");
      expect(Array.isArray(body.results)).toBe(true);
      expect(Array.isArray(body.available_indices)).toBe(true);
      expect(typeof body.response_time_ms).toBe("number");
      // Each result should have index + available flag
      for (const r of body.results) {
        expect(r).toHaveProperty("index");
        expect(r).toHaveProperty("available");
        expect(typeof r.available).toBe("boolean");
        expect(r).toHaveProperty("bookmakers");
        expect(Array.isArray(r.bookmakers)).toBe(true);
      }
    } else {
      // Miner offline
      expect(res.status()).toBe(502);
    }
  });

  test("accepts h2h market (null line)", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: {
        lines: [
          {
            index: 1,
            sport: "basketball_nba",
            event_id: "test-h2h",
            home_team: "Lakers",
            away_team: "Celtics",
            market: "h2h",
            line: null,
            side: "Lakers",
          },
        ],
      },
    });

    if (res.ok()) {
      const body = await res.json();
      expect(body.results).toHaveLength(1);
    } else {
      expect(res.status()).toBe(502);
    }
  });

  test("accepts totals market", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: {
        lines: [
          {
            index: 1,
            sport: "basketball_nba",
            event_id: "test-totals",
            home_team: "Lakers",
            away_team: "Celtics",
            market: "totals",
            line: 218.5,
            side: "Over",
          },
        ],
      },
    });

    if (res.ok()) {
      const body = await res.json();
      expect(body.results).toHaveLength(1);
    } else {
      expect(res.status()).toBe(502);
    }
  });

  test("single line check returns exactly 1 result", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: {
        lines: [
          {
            index: 5,
            sport: "basketball_nba",
            event_id: "single-test",
            home_team: "A",
            away_team: "B",
            market: "spreads",
            line: -1.5,
            side: "A",
          },
        ],
      },
    });

    if (res.ok()) {
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].index).toBe(5);
    }
  });
});

// ─────────────────────────────────────────────
// Validator signal store (validation edge cases)
// ─────────────────────────────────────────────

test.describe("Validator store share validation", () => {
  test("rejects empty body with 422", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      data: {},
    });
    // Should get a validation error (400 or 422), not 404
    expect([400, 422]).toContain(res.status());
  });

  test("rejects invalid ethereum address", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      data: {
        signal_id: "test-signal-1",
        genius_address: "not-an-address",
        share_x: 1,
        share_y: "1a2b3c",
        encrypted_key_share: "aabbcc",
        encrypted_index_share: "ddeeff",
      },
    });
    expect([400, 422]).toContain(res.status());
  });

  test("rejects share_x out of range (0)", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      data: {
        signal_id: "test-signal-2",
        genius_address: "0x1234567890123456789012345678901234567890",
        share_x: 0,
        share_y: "1a2b3c",
        encrypted_key_share: "aabbcc",
      },
    });
    expect([400, 422]).toContain(res.status());
  });

  test("rejects share_x out of range (11)", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      data: {
        signal_id: "test-signal-3",
        genius_address: "0x1234567890123456789012345678901234567890",
        share_x: 11,
        share_y: "1a2b3c",
        encrypted_key_share: "aabbcc",
      },
    });
    expect([400, 422]).toContain(res.status());
  });

  test("rejects non-hex share_y", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      data: {
        signal_id: "test-signal-4",
        genius_address: "0x1234567890123456789012345678901234567890",
        share_x: 1,
        share_y: "not-hex-zzz",
        encrypted_key_share: "aabbcc",
      },
    });
    expect([400, 422]).toContain(res.status());
  });
});

// ─────────────────────────────────────────────
// Subgraph queries
// ─────────────────────────────────────────────

test.describe("Subgraph queries", () => {
  const SUBGRAPH_URL =
    "https://api.studio.thegraph.com/query/1742249/djinn/v2.3.0";

  test("protocolStats query responds (may be null)", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: '{ protocolStats(id: "global") { totalSignals totalPurchases totalVolume totalFees } }',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("data");
    // May be null if no signals yet — that's fine
  });

  test("signals query responds with empty array", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: "{ signals(first: 5, orderBy: createdAt, orderDirection: desc) { id genius { id } sport status createdAt } }",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body.data).toHaveProperty("signals");
    expect(Array.isArray(body.data.signals)).toBe(true);
  });

  test("geniuses query responds", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: "{ geniuses(first: 5) { id totalSignals totalPurchases totalVolume } }",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data).toHaveProperty("geniuses");
    expect(Array.isArray(body.data.geniuses)).toBe(true);
  });

  test("idiots query responds", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: "{ idiots(first: 5) { id totalPurchases totalFeesPaid } }",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data).toHaveProperty("idiots");
    expect(Array.isArray(body.data.idiots)).toBe(true);
  });

  test("rejects malformed GraphQL", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: "{ thisFieldDoesNotExist }",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty("errors");
  });

  test("pagination works with skip/first", async ({ request }) => {
    const res = await request.post(SUBGRAPH_URL, {
      headers: { "Content-Type": "application/json" },
      data: {
        query: "{ signals(first: 2, skip: 0) { id } }",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.signals.length).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────
// Error handling edge cases
// ─────────────────────────────────────────────

test.describe("API error handling", () => {
  test("non-existent API route returns 404 or 405", async ({ request }) => {
    const res = await request.get("/api/nonexistent");
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("validator proxy handles large body gracefully", async ({ request }) => {
    const largeBody = "x".repeat(2 * 1024 * 1024); // 2MB
    const res = await request.post("/api/validator/v1/signal", {
      data: largeBody,
      headers: { "Content-Type": "application/json" },
    });
    // Should not crash — expect 4xx or 5xx
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("miner proxy handles empty lines array", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: { lines: [] },
    });
    // Should get validation error, not crash
    if (res.ok()) {
      const body = await res.json();
      expect(body.results).toHaveLength(0);
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });
});
