import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

test.describe("Miner & Purchase Flow Smoke Tests", () => {
  test("miner health proxy returns ok", async ({ request }) => {
    const res = await request.get("/api/miner/health");
    // If miner is running, expect 200; if not, expect 502
    if (res.ok()) {
      const body = await res.json();
      expect(["ok", "degraded"]).toContain(body.status);
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("odds_api_connected");
    } else {
      // Miner offline — expect 502 with graceful error
      expect(res.status()).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Miner unavailable");
    }
  });

  test("miner proxy rejects disallowed paths", async ({ request }) => {
    const res = await request.get("/api/miner/v1/proof");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("line check endpoint accepts valid request", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      data: {
        lines: [
          {
            index: 1,
            sport: "basketball_nba",
            event_id: "test-event",
            home_team: "Test Home",
            away_team: "Test Away",
            market: "spreads",
            line: -3.5,
            side: "Test Home",
          },
        ],
      },
    });
    // Miner running: expect 200 with results
    // Miner offline: expect 502
    if (res.ok()) {
      const body = await res.json();
      expect(body).toHaveProperty("results");
      expect(body).toHaveProperty("available_indices");
      expect(body).toHaveProperty("response_time_ms");
      expect(Array.isArray(body.results)).toBe(true);
    } else {
      expect(res.status()).toBe(502);
    }
  });

  test("idiot dashboard loads and shows content", async ({
    page,
  }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible();
    // Dashboard should show connect prompt or signal content
    await expect(
      page.getByText(/connect|signal|wallet/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("browse signals page loads", async ({ page }) => {
    await page.goto("/idiot/browse");
    // Should either show the browse page or redirect to idiot dashboard
    await expect(
      page.getByText(/browse|signal|available/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
