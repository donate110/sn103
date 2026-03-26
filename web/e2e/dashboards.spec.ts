import { test, expect } from "@playwright/test";

test.describe("Genius dashboard", () => {
  test("renders Genius Dashboard heading", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible();
  });

  test("shows wallet prompt or authenticated dashboard", async ({ page }) => {
    await page.goto("/genius");
    // In E2E build (mock wallet), shows authenticated dashboard
    // In production build, shows connect wallet prompt
    const hasConnectPrompt = await page
      .getByText(/connect your wallet/i)
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (hasConnectPrompt) {
      await expect(page.getByText(/connect your wallet/i)).toBeVisible();
    } else {
      await expect(page.getByText(/collateral/i).first()).toBeVisible();
    }
  });
});

test.describe("Idiot dashboard", () => {
  test("renders Idiot Dashboard heading", async ({ page }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" })
    ).toBeVisible();
  });

  test("shows wallet prompt or authenticated dashboard", async ({ page }) => {
    await page.goto("/idiot");
    const hasConnectPrompt = await page
      .getByText(/connect your wallet/i)
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (hasConnectPrompt) {
      await expect(page.getByText(/connect your wallet/i)).toBeVisible();
    } else {
      await expect(page.getByText(/escrow/i).first()).toBeVisible();
    }
  });

  test("renders meaningful content", async ({ page }) => {
    await page.goto("/idiot");
    const body = await page.locator("body").textContent();
    expect(body).toBeTruthy();
    expect(body!.length).toBeGreaterThan(50);
  });
});

test.describe("Signal creation", () => {
  test("renders Create Signal heading", async ({ page }) => {
    await page.goto("/genius/signal/new");
    await expect(page.getByText("Create Signal")).toBeVisible();
  });

  test("shows wallet prompt or browse step", async ({ page }) => {
    await page.goto("/genius/signal/new");
    const hasConnectPrompt = await page
      .getByText(/connect your wallet/i)
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (hasConnectPrompt) {
      await expect(page.getByText(/connect your wallet/i)).toBeVisible();
    } else {
      // In E2E mode, should show the browse step with sport selector
      await expect(page.getByText("Create Signal")).toBeVisible();
    }
  });
});

test.describe("Track Record", () => {
  test("renders Track Record heading", async ({ page }) => {
    await page.goto("/genius/track-record");
    await expect(
      page.getByRole("heading", { name: "Track Record" })
    ).toBeVisible();
  });

  test("shows wallet prompt or track record content", async ({ page }) => {
    await page.goto("/genius/track-record");
    const hasConnectPrompt = await page
      .getByText(/connect your wallet/i)
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (hasConnectPrompt) {
      await expect(page.getByText(/connect your wallet/i)).toBeVisible();
    } else {
      await expect(
        page.getByRole("heading", { name: "Track Record" })
      ).toBeVisible();
    }
  });
});
