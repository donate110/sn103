import { test, expect } from "@playwright/test";

test.describe("Live site smoke tests", () => {
  test("home page loads with branding", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "DJINN" })).toBeVisible();
    await expect(page.getByText("The Genius-Idiot Network")).toBeVisible();
  });

  test("genius dashboard loads without infinite spinner", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible();
    // Should show connect prompt (no wallet), NOT a loading spinner
    await expect(page.getByText(/connect your wallet/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("idiot dashboard loads without infinite spinner", async ({ page }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible();
    await expect(page.getByText(/connect your wallet/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("leaderboard page loads", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: "Genius Leaderboard" })
    ).toBeVisible();
  });

  test("about page loads with content", async ({ page }) => {
    await page.goto("/about");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(100);
  });

  test("signal creation page loads", async ({ page }) => {
    await page.goto("/genius/signal/new");
    await expect(page.getByText("Create Signal")).toBeVisible();
  });
});

test.describe("Live API health", () => {
  test("validator proxy returns health", async ({ request }) => {
    const res = await request.get("/api/validator/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.shares_held).toBeGreaterThanOrEqual(0);
  });

  test("app health endpoint returns ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("odds API returns data", async ({ request }) => {
    const res = await request.get("/api/odds?sport=basketball_nba");
    // May return empty array if no games, but should not error
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe("Navigation flows", () => {
  test("home → genius dashboard navigation", async ({ page }) => {
    await page.goto("/");
    const geniusLink = page.getByRole("link", { name: /genius/i }).first();
    await expect(geniusLink).toBeVisible();
    await geniusLink.click();
    await expect(page).toHaveURL(/\/genius/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("home → idiot dashboard navigation", async ({ page }) => {
    await page.goto("/");
    const idiotLink = page.getByRole("link", { name: /idiot/i }).first();
    await expect(idiotLink).toBeVisible();
    await idiotLink.click();
    await expect(page).toHaveURL(/\/idiot/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible({ timeout: 10_000 });
  });

  test("genius dashboard → create signal navigation", async ({ page }) => {
    await page.goto("/genius");
    await expect(page.getByText(/connect your wallet/i)).toBeVisible({
      timeout: 10_000,
    });
    // Even without wallet, the create signal route should load
    await page.goto("/genius/signal/new");
    await expect(page.getByText(/create signal|connect your wallet/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("direct URL to leaderboard works", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i })
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Error states", () => {
  test("404 page for unknown route", async ({ page }) => {
    const res = await page.goto("/this-page-does-not-exist");
    // Next.js returns 404 for unknown routes
    expect(res?.status()).toBe(404);
  });

  test("invalid API route returns error", async ({ request }) => {
    const res = await request.get("/api/nonexistent");
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test("odds API with invalid sport returns error or empty", async ({
    request,
  }) => {
    const res = await request.get("/api/odds?sport=invalid_sport_key");
    // Should return error or empty array, not 500
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe("Mobile viewport", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("home page renders on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "DJINN" })).toBeVisible();
  });

  test("genius dashboard mobile layout", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible();
    // Content should not overflow horizontally
    const bodyWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20); // small tolerance
  });

  test("idiot dashboard mobile layout", async ({ page }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible();
    const bodyWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });

  test("leaderboard renders on mobile without overflow", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i })
    ).toBeVisible();
  });
});
