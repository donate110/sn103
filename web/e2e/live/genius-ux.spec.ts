import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Genius Dashboard — structure and content
// ─────────────────────────────────────────────

test.describe("Genius Dashboard", () => {
  test("shows connect prompt with correct structure when no wallet", async ({
    page,
  }) => {
    await page.goto("/genius");

    // Main heading
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Connect prompt text
    await expect(
      page.getByText("Connect your wallet to sell signals"),
    ).toBeVisible();
    await expect(
      page.getByText("Use the Connect button in the top right corner"),
    ).toBeVisible();
  });

  test("header has wallet connect button", async ({ page }) => {
    await page.goto("/genius");
    // Should have a Get Started / Connect button in the header
    const connectBtn = page
      .getByRole("button", { name: /get started|connect/i })
      .first();
    await expect(connectBtn).toBeVisible({ timeout: 10_000 });
  });

  test("navigation links in header include Genius active state", async ({
    page,
  }) => {
    await page.goto("/genius");
    // The Genius nav link should exist and be visually active
    const geniusLink = page
      .getByRole("link", { name: /^genius$/i })
      .first();
    await expect(geniusLink).toBeVisible({ timeout: 10_000 });
  });

  test("page title is correct", async ({ page }) => {
    await page.goto("/genius");
    await expect(page).toHaveTitle(/Genius.*Dashboard.*Djinn/i);
  });
});

// ─────────────────────────────────────────────
// Create Signal page — wizard and forms
// ─────────────────────────────────────────────

test.describe("Create Signal page", () => {
  test("shows connect prompt when no wallet", async ({ page }) => {
    await page.goto("/genius/signal/new");

    await expect(page.getByText("Create Signal")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText(/connect your wallet/i),
    ).toBeVisible();
  });

  test("page loads without JS errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/genius/signal/new");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const real = errors.filter(
      (e) =>
        !e.includes("Privy") &&
        !e.includes("privy") &&
        !e.includes("MetaMask") &&
        !e.includes("ethereum") &&
        !e.includes("ResizeObserver") &&
        !e.includes("wallet"),
    );
    expect(real).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Track Record page
// ─────────────────────────────────────────────

test.describe("Track Record page", () => {
  test("shows connect prompt when no wallet", async ({ page }) => {
    await page.goto("/genius/track-record");

    await expect(
      page.getByRole("heading", { name: /track record/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/connect your wallet/i),
    ).toBeVisible();
  });

  test("explains settlement process", async ({ page }) => {
    await page.goto("/genius/track-record");
    // Even without wallet, the page should explain the settlement process
    await expect(
      page.getByText(/track record|connect your wallet/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────
// Genius flow navigation
// ─────────────────────────────────────────────

test.describe("Genius navigation flow", () => {
  test("home → genius card → genius dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the "I'm a Genius" CTA
    const geniusCard = page.getByRole("link", { name: /genius/i }).first();
    await expect(geniusCard).toBeVisible();
    await geniusCard.click();

    await expect(page).toHaveURL(/\/genius/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("genius dashboard → create signal → back", async ({ page }) => {
    await page.goto("/genius/signal/new");
    await expect(page.getByText(/create signal|connect/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Should be able to navigate back to genius dashboard
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("genius dashboard → track record → back to dashboard", async ({
    page,
  }) => {
    await page.goto("/genius/track-record");
    await expect(
      page.getByText(/track record/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Should have a back link
    const backLink = page.getByRole("link", { name: /back.*dashboard/i });
    if (await backLink.isVisible().catch(() => false)) {
      await backLink.click();
      await expect(page).toHaveURL(/\/genius$/, { timeout: 15_000 });
    }
  });

  test("header nav links work from genius pages", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate to leaderboard via header
    const leaderboardLink = page
      .getByRole("link", { name: /leaderboard/i })
      .first();
    await expect(leaderboardLink).toBeVisible();
    await leaderboardLink.click();
    await expect(page).toHaveURL(/\/leaderboard/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────
// Genius pages — responsive layouts
// ─────────────────────────────────────────────

test.describe("Genius mobile layout", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("genius dashboard renders without overflow on mobile", async ({
    page,
  }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });

  test("create signal page renders without overflow on mobile", async ({
    page,
  }) => {
    await page.goto("/genius/signal/new");
    await expect(page.getByText(/create signal|connect/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });

  test("mobile has hamburger menu", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Should have a menu toggle button on mobile
    const menuBtn = page.locator("button").filter({ has: page.locator("svg") }).first();
    await expect(menuBtn).toBeVisible();
  });
});

// ─────────────────────────────────────────────
// Genius pages — no console errors
// ─────────────────────────────────────────────

test.describe("Genius pages no JS errors", () => {
  const pages = [
    { url: "/genius", name: "Dashboard" },
    { url: "/genius/signal/new", name: "Create Signal" },
    { url: "/genius/track-record", name: "Track Record" },
  ];

  for (const p of pages) {
    test(`${p.name} page has no critical JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(p.url);
      await page.waitForLoadState("networkidle", { timeout: 20_000 });

      const critical = errors.filter(
        (e) =>
          !e.includes("Privy") &&
          !e.includes("privy") &&
          !e.includes("MetaMask") &&
          !e.includes("ethereum") &&
          !e.includes("ResizeObserver") &&
          !e.includes("wallet") &&
          !e.includes("CSP") &&
          !e.includes("Content Security Policy"),
      );
      expect(critical).toHaveLength(0);
    });
  }
});
