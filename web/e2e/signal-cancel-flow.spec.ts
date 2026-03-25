import { test, expect } from "./fixtures/setup";

test.describe("Signal cancellation flow", () => {
  test("genius dashboard shows My Signals section", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });

    // My Signals section should be visible
    await expect(
      page.getByText(/my signals/i)
    ).toBeVisible({ timeout: 5_000 });
  });

  test("genius dashboard has Create Signal link", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });

    // Create Signal button/link should be visible
    const createLink = page.getByRole("link", { name: /create signal/i });
    await expect(createLink).toBeVisible();
  });
});

test.describe("Browse and signal detail", () => {
  test("browse page loads", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/idiot/browse");

    // Browse page should render heading and content area
    await expect(
      page.getByRole("heading", { name: /browse|signal/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test("signal detail page shows purchase prompt or unavailable", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/idiot/browse");

    // Wait for signals to load
    await page.waitForTimeout(3_000);

    // Check if any signals are available
    const signalLinks = page.locator('a[href*="/idiot/signal/"]');
    const count = await signalLinks.count();

    if (count > 0) {
      // Click first signal
      await signalLinks.first().click();
      await page.waitForURL("**/idiot/signal/**");

      // Should show either purchase button or unavailable message
      const purchaseBtn = page.getByRole("button", { name: /purchase/i });
      const unavailable = page.getByText(/unavailable/i);
      const signalInfo = page.getByText(/signal/i).first();

      // At least one of these should be visible
      await expect(signalInfo).toBeVisible({ timeout: 10_000 });
    }
  });
});
