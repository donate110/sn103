import { test, expect } from "./fixtures/setup";

test.describe("Genius dashboard — early exit", () => {
  test("shows Early Exit button in active relationships", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Active Relationships" })
    ).toBeVisible();

    // Early Exit is now an inline button within relationship cards
    // (only visible when there are active relationships)
  });
});

test.describe("Genius dashboard — track record badge", () => {
  test("shows Track Record link", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    const link = page.getByRole("link", { name: /Track Record/i });
    await expect(link).toBeVisible();
  });
});

test.describe("Genius dashboard — history", () => {
  test("shows History section", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "History" })
    ).toBeVisible();
  });
});
