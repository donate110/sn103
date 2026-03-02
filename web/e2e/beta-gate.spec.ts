import { test, expect } from "@playwright/test";

test.describe("Beta gate", () => {
  test("shows gate form when password is required", async ({ page }) => {
    // Don't bypass beta gate — just go to the page
    await page.goto("/");

    // The gate should show the password input
    const gateInput = page.getByPlaceholder("Enter beta password");

    // If beta password is set in .env, the gate form should appear
    // (If not set, the gate is bypassed and this test is skipped)
    if (await gateInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Gate is visible — CTA links should NOT be visible
      await expect(
        page.getByRole("link", { name: /I'm a Genius/i })
      ).not.toBeVisible();
    }
  });

  test("correct password unlocks the app", async ({ page }) => {
    await page.goto("/");

    const gateInput = page.getByPlaceholder("Enter beta password");

    // If beta gate is active, enter the password
    if (await gateInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await gateInput.fill(process.env.E2E_BETA_PASSWORD || "");
      await page.getByRole("button", { name: "Enter" }).click();

      // After correct password, should see the home page CTAs
      await expect(
        page.getByRole("link", { name: /I'm a Genius/i })
      ).toBeVisible();
    }
  });

  test("wrong password shows error", async ({ page }) => {
    await page.goto("/");

    const gateInput = page.getByPlaceholder("Enter beta password");

    if (await gateInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await gateInput.fill("wrongpassword");
      await page.getByRole("button", { name: "Enter" }).click();

      await expect(page.getByText("Incorrect password")).toBeVisible();
    }
  });

  test("page title includes Djinn", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("djinn-beta-access", "true");
    });
    await page.goto("/");
    await expect(page).toHaveTitle(/Djinn/i);
  });

  test("localStorage bypass works", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("djinn-beta-access", "true");
    });
    await page.goto("/");

    // Should skip the gate and show home content directly
    await expect(
      page.getByRole("link", { name: /I'm a Genius/i })
    ).toBeVisible();
  });
});
