import { test, expect } from "@playwright/test";

test.describe("Network page", () => {
  test("loads and shows stat cards", async ({ page }) => {
    await page.goto("/network");
    // Network page uses ssr:false + async data fetch. Wait for stat cards.
    await expect(page.getByText("Miners", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText("Validators", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("GINI")).toBeVisible();
  });

  test("shows miner table with UID links", async ({ page }) => {
    await page.goto("/network");
    await expect(page.getByText("Miners", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    const firstMinerLink = page.locator("table").first().getByRole("link").first();
    await expect(firstMinerLink).toBeVisible();
    const href = await firstMinerLink.getAttribute("href");
    expect(href).toMatch(/\/network\/miner\/\d+/);
  });

  test("shows validator table with UID links", async ({ page }) => {
    await page.goto("/network");
    await expect(page.getByRole("heading", { name: /Validators/i })).toBeVisible({ timeout: 20000 });
    const valTable = page.locator("table").last();
    const firstValLink = valTable.getByRole("link").first();
    await expect(firstValLink).toBeVisible();
    const href = await firstValLink.getAttribute("href");
    expect(href).toMatch(/\/network\/validator\/\d+/);
  });

  test("no search box on page", async ({ page }) => {
    await page.goto("/network");
    await expect(page.getByText("Miners", { exact: true }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByPlaceholder("Enter miner UID")).not.toBeVisible();
  });
});

test.describe("Miner detail page", () => {
  test("renders miner heading", async ({ page }) => {
    await page.goto("/network/miner/1");
    await expect(
      page.getByRole("heading", { name: /Miner UID 1/i })
    ).toBeVisible({ timeout: 15000 });
  });

  test("has breadcrumb to network", async ({ page }) => {
    await page.goto("/network/miner/1");
    await expect(
      page.getByRole("heading", { name: /Miner UID 1/i })
    ).toBeVisible({ timeout: 15000 });
    // Breadcrumb is inside main content area
    const breadcrumb = page.getByRole("main").getByRole("link", { name: "Network" });
    await expect(breadcrumb).toBeVisible();
  });
});

test.describe("Validator detail page", () => {
  test("renders validator heading for valid UID", async ({ page }) => {
    await page.goto("/network/validator/1");
    await expect(
      page.getByRole("heading", { name: /Validator UID 1/i })
    ).toBeVisible({ timeout: 15000 });
  });

  test("shows miner scoring table", async ({ page }) => {
    await page.goto("/network/validator/1");
    await expect(
      page.getByRole("heading", { name: /Miner Scoring/i })
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("columnheader", { name: /Weight/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Attest/i })).toBeVisible();
  });

  test("has breadcrumb to network", async ({ page }) => {
    await page.goto("/network/validator/1");
    await expect(
      page.getByRole("heading", { name: /Validator UID 1/i })
    ).toBeVisible({ timeout: 15000 });
    const breadcrumb = page.getByRole("main").getByRole("link", { name: "Network" });
    await expect(breadcrumb).toBeVisible();
  });

  test("shows error for invalid validator UID", async ({ page }) => {
    await page.goto("/network/validator/999");
    await expect(
      page.getByText(/not found|unreachable/i)
    ).toBeVisible({ timeout: 15000 });
  });
});
