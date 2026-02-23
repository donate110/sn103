import { test, expect } from "./fixtures/setup";

test.describe("Genius dashboard — early exit section", () => {
  test("shows Early Exit section with form", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Early Exit" })
    ).toBeVisible();
    await expect(
      page.getByText(/end a relationship early/i)
    ).toBeVisible();
  });

  test("early exit form has counterparty input", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    const input = page.getByLabel(/Idiot Address/i);
    await expect(input).toBeVisible();
    await input.fill("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(await input.inputValue()).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
    );
  });

  test("early exit button is disabled when no counterparty", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    const button = page.getByRole("button", { name: /Trigger Early Exit/i });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
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

test.describe("Genius dashboard — audit history", () => {
  test("shows audit history table", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Audit History" })
    ).toBeVisible();
  });

  test("shows settlement history section", async ({
    authenticatedPage: page,
  }) => {
    await page.goto("/genius");

    await expect(
      page.getByRole("heading", { name: "Settlement History" })
    ).toBeVisible();
  });
});
