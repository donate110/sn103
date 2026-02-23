import { test, expect } from "./fixtures/setup";

test.describe("Genius dashboard (wallet connected)", () => {
  test("shows dashboard content instead of connect prompt", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    // With mock wallet connected, should NOT show the connect prompt
    await expect(page.getByText(/connect your wallet/i)).not.toBeVisible();

    // Should show the authenticated dashboard
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible();
    await expect(page.getByText("Create Signal")).toBeVisible();
  });

  test("shows wallet address in header", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    // The mock wallet address should appear (truncated: 0xf39F...2266)
    await expect(page.getByTestId("wallet-address")).toBeVisible();
    await expect(page.getByTestId("wallet-address")).toContainText("0xf39F");
  });

  test("shows collateral section with deposit/withdraw forms", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    // Wait for the authenticated dashboard to render
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });

    // Collateral stat card visible (rendered in uppercase via CSS)
    await expect(page.getByText(/collateral/i).first()).toBeVisible({ timeout: 5_000 });

    // Deposit/withdraw forms below
    await expect(
      page.getByPlaceholder("Amount (USDC)").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("navigates to Create Signal page", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await page.getByRole("link", { name: "Create Signal" }).click();
    await page.waitForURL("**/genius/signal/new");

    await expect(page.getByText("Create Signal")).toBeVisible();
  });

  test("navigates to Track Record page", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await page.getByRole("link", { name: "Track Record" }).click();
    await page.waitForURL("**/genius/track-record");

    await expect(
      page.getByRole("heading", { name: "Track Record" })
    ).toBeVisible();
  });
});
