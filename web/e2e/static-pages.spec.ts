import { test, expect } from "@playwright/test";

test.describe("About page", () => {
  test("renders about content", async ({ page }) => {
    await page.goto("/about");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(100);
  });
});

test.describe("Privacy page", () => {
  test("renders privacy content", async ({ page }) => {
    await page.goto("/privacy");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(100);
  });
});

test.describe("Terms page", () => {
  test("renders terms content", async ({ page }) => {
    await page.goto("/terms");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(100);
  });
});

test.describe("Press page", () => {
  test("renders press content", async ({ page }) => {
    await page.goto("/press");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(50);
  });
});

test.describe("Health endpoint", () => {
  test("returns 200 with status ok", async ({ request }) => {
    const resp = await request.get("/api/health");
    // Vercel bot protection may return 403 for API requests from Playwright
    if (resp.status() === 403) {
      test.skip(true, "Vercel bot protection blocked the request");
      return;
    }
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json.status).toBe("ok");
  });
});

test.describe("404 handling", () => {
  test("nonexistent page shows not found", async ({ page }) => {
    const resp = await page.goto("/this-page-does-not-exist-at-all");
    // Vercel may return 403 (bot protection) instead of 404 for unknown routes
    expect([404, 403]).toContain(resp?.status());
  });
});
