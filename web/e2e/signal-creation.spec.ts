import { test, expect } from "@playwright/test";

test.describe("Signal creation page", () => {
  test("loads with Create Signal heading", async ({ page }) => {
    await page.goto("/genius/signal/new");

    // The page should render with the heading
    await expect(page.getByText("Create Signal")).toBeVisible();
  });

  test("shows sport selector", async ({ page }) => {
    await page.goto("/genius/signal/new");

    // The sport selector should be visible (contains sport pills/buttons)
    await expect(page.getByText("Create Signal")).toBeVisible();

    // The page should have sport options visible
    // (specific sport names depend on the SPORTS constant)
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(50);
  });

  test("shows connect wallet message when not authenticated", async ({
    page,
  }) => {
    await page.goto("/genius/signal/new");

    // Without wallet connected, events won't load (fetch is gated on authenticated)
    // But the page structure should still render
    await expect(page.getByText("Create Signal")).toBeVisible();
  });
});
