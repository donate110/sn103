import { test, expect } from "./fixtures/setup";

test.describe("Collateral deposit flow", () => {
  test("deposit form accepts amount and shows deposit button", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    // Wait for dashboard to render with collateral section
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });

    // Find the deposit input
    const depositInput = page.getByPlaceholder("Amount (USDC)").first();
    await expect(depositInput).toBeVisible({ timeout: 5_000 });

    // Fill in an amount
    await depositInput.fill("100");

    // Find and verify the deposit button
    const depositBtn = page.getByRole("button", { name: /deposit/i }).first();
    await expect(depositBtn).toBeVisible();
    await expect(depositBtn).toBeEnabled();
  });

  test("withdraw form accepts amount", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" })
    ).toBeVisible({ timeout: 10_000 });

    // The withdraw input should exist
    const inputs = page.getByPlaceholder("Amount (USDC)");
    // Second input is withdraw
    const withdrawInput = inputs.nth(1);
    await expect(withdrawInput).toBeVisible({ timeout: 5_000 });

    await withdrawInput.fill("50");
  });
});

test.describe("Escrow deposit flow (Idiot)", () => {
  test("deposit form accepts amount and shows deposit button", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/idiot");

    // Wait for idiot dashboard
    await expect(
      page.getByText(/escrow/i).first()
    ).toBeVisible({ timeout: 10_000 });

    // Find deposit input
    const depositInput = page.getByPlaceholder("Amount (USDC)").first();
    await expect(depositInput).toBeVisible({ timeout: 5_000 });

    await depositInput.fill("100");

    const depositBtn = page.getByRole("button", { name: /deposit/i }).first();
    await expect(depositBtn).toBeVisible();
  });
});
