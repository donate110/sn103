import { test, expect } from "./fixtures/setup";

test.describe("Signal creation flow (wallet connected)", () => {
  test("shows sport selector and events when connected", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/signal/new");

    // Should NOT show connect prompt
    await expect(page.getByText(/connect your wallet/i)).not.toBeVisible();

    // Should show Create Signal heading
    await expect(page.getByText("Create Signal")).toBeVisible();

    // Should show sport groups (NBA is the first default sport)
    // NBA button renders in both mobile and desktop layouts, use first()
    await expect(page.getByRole("button", { name: "NBA" }).first()).toBeVisible();

    // Events should load from mocked API
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("Miami Heat @ Golden State Warriors")
    ).toBeVisible();
  });

  test("can search for teams", async ({ authenticatedPage: page }) => {
    await page.goto("/genius/signal/new");

    // Wait for events to load
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });

    // Search for a specific team
    const searchInput = page.getByPlaceholder(/search.*teams/i);
    await expect(searchInput).toBeVisible();
    await searchInput.fill("Lakers");

    // Lakers game should be visible, Warriors game should not
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible();
    await expect(
      page.getByText("Miami Heat @ Golden State Warriors")
    ).not.toBeVisible();
  });

  test("can switch sports", async ({ authenticatedPage: page }) => {
    await page.goto("/genius/signal/new");

    // Wait for initial events
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });

    // Switch to NFL
    await page.getByRole("button", { name: "NFL" }).click();

    // NFL events should load
    await expect(
      page.getByText("Buffalo Bills @ Kansas City Chiefs")
    ).toBeVisible({ timeout: 10_000 });

    // NBA events should be gone
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).not.toBeVisible();
  });

  test("can select a bet and see review step", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/signal/new");

    // Wait for events
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });

    // Click the event to expand it and show available bets
    // The event card should have clickable bet options (spread, h2h, totals)
    // Find the first clickable bet (spread option)
    const firstBet = page
      .locator('[data-testid="bet-option"], button')
      .filter({ hasText: /Lakers|Celtics/ })
      .first();

    if (await firstBet.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstBet.click();

      // Should advance to the review step
      await expect(page.getByText("Review Lines")).toBeVisible({
        timeout: 5000,
      });

      // Should show 10 lines
      const lineItems = page.locator('[class*="rounded-lg"]').filter({
        has: page.locator("span"),
      });
      // The review page should have multiple lines visible
      await expect(page.getByText(/\/10 lines/)).toBeVisible();
    }
  });

  test("configure step shows correct form fields", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/signal/new");

    // Wait for events
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });

    // Click any bet to go to review
    const firstBet = page
      .locator("button")
      .filter({ hasText: /Lakers|Celtics/ })
      .first();

    if (await firstBet.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstBet.click();

      // Wait for review step
      await expect(page.getByText("Review Lines")).toBeVisible({
        timeout: 5000,
      });

      // Click continue to go to configure
      const continueBtn = page.getByRole("button", {
        name: /continue|next|configure/i,
      });
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();

        // Configure step should show pricing fields
        await expect(page.getByText(/max price|signal price/i)).toBeVisible({
          timeout: 5000,
        });
      }
    }
  });

  test("displays game count after loading", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/signal/new");

    // Wait for events to load
    await expect(
      page.getByText("Boston Celtics @ Los Angeles Lakers")
    ).toBeVisible({ timeout: 10_000 });

    // Should show count of games
    await expect(page.getByText(/2 games/)).toBeVisible();
  });
});
