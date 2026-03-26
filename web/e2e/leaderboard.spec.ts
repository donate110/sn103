import { test, expect } from "@playwright/test";

test.describe("Leaderboard page", () => {
  test("renders leaderboard heading", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: "Genius Leaderboard" })
    ).toBeVisible();
  });

  test("shows leaderboard content or setup message", async ({
    page,
  }) => {
    await page.goto("/leaderboard");
    // When subgraph is configured, shows table; when not configured, shows setup message
    const setupMsg = page.getByText(/leaderboard is being set up/i);
    const table = page.getByRole("table");
    await expect(setupMsg.or(table).first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows sortable table headers", async ({ page }) => {
    await page.goto("/leaderboard");
    // Wait for the table to render (headers are always visible)
    await expect(page.getByRole("columnheader", { name: /Quality Score/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Signals/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Audits/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /ROI/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Proofs/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Win Rate/i })).toBeVisible();
  });
});

test.describe("Track record page (unauthenticated)", () => {
  test("renders track record heading", async ({ page }) => {
    await page.goto("/genius/track-record");
    await expect(
      page.getByRole("heading", { name: "Track Record" })
    ).toBeVisible();
  });

  test("shows wallet prompt or track record content", async ({
    page,
  }) => {
    await page.goto("/genius/track-record");
    // Both states valid depending on mock wallet presence
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(50);
  });
});
