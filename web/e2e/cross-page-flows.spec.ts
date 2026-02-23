import { test, expect } from "./fixtures/setup";

test.describe("Cross-page navigation flows", () => {
  test("genius page loads and shows heading", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");
    // Without wallet connection, shows connect prompt with heading
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible();
  });

  test("idiot page loads and shows heading", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible();
  });

  test("track record page loads directly", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/track-record");
    await expect(
      page.getByRole("heading", { name: "Track Record" })
    ).toBeVisible();
  });

  test("leaderboard → home navigation", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: "Genius Leaderboard" })
    ).toBeVisible();

    // Click brand/home link
    await page.getByRole("link", { name: /djinn/i }).first().click();
    await page.waitForURL("/");
  });

  test("signal creation page loads", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/signal/new");
    // Should show the signal creation page (may need wallet for full wizard)
    await expect(page.getByText(/Create Signal/i).first()).toBeVisible();
  });
});
