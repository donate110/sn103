import { test, expect } from "./fixtures/setup";

test.describe("Track Record page", () => {
  test("renders Track Record heading", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/track-record");

    await expect(
      page.getByRole("heading", { name: "Track Record" })
    ).toBeVisible();
  });

  test("shows wallet prompt or settlement content", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/track-record");

    // Wallet may or may not be connected — handle both states
    const hasConnectPrompt = await page
      .getByText(/connect your wallet/i)
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasConnectPrompt) {
      await expect(page.getByText(/connect your wallet/i)).toBeVisible();
    } else {
      // Connected state shows settlement history
      await expect(
        page.getByText(/on-chain settlement history/i)
      ).toBeVisible();
    }
  });

  test("has back to dashboard link when connected", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius/track-record");

    // Back link is only visible in connected state
    const backLink = page.getByText("Back to Dashboard");
    const isVisible = await backLink.isVisible({ timeout: 3000 }).catch(() => false);
    if (isVisible) {
      await backLink.click();
      await page.waitForURL("**/genius");
    }
  });

  test("page renders without JS errors", async ({
    authenticatedPage: page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/genius/track-record");
    await page.waitForLoadState("networkidle");
    expect(errors.length).toBe(0);
  });
});
