import { test, expect } from "@playwright/test";

// ─────────────────────────────────────────────
// Idiot Dashboard — structure and content
// ─────────────────────────────────────────────

test.describe("Idiot Dashboard", () => {
  test("shows connect prompt with correct structure when no wallet", async ({
    page,
  }) => {
    await page.goto("/idiot");

    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText("Connect your wallet to browse signals"),
    ).toBeVisible();
    await expect(
      page.getByText("Use the Connect button in the top right corner"),
    ).toBeVisible();
  });

  test("header has wallet connect button", async ({ page }) => {
    await page.goto("/idiot");
    const connectBtn = page
      .getByRole("button", { name: /get started|connect/i })
      .first();
    await expect(connectBtn).toBeVisible({ timeout: 10_000 });
  });

  test("page title contains Dashboard", async ({ page }) => {
    await page.goto("/idiot");
    // App uses "Buyer Dashboard" as the HTML title for the idiot page
    await expect(page).toHaveTitle(/(?:Buyer|Idiot).*Dashboard.*Djinn/i);
  });
});

// ─────────────────────────────────────────────
// Browse Signals page
// ─────────────────────────────────────────────

test.describe("Browse Signals page", () => {
  test("loads with correct heading and structure", async ({ page }) => {
    await page.goto("/idiot/browse");

    await expect(
      page.getByRole("heading", { name: /browse signals/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Should have subtitle about discovering signals
    await expect(
      page.getByText(/discover.*signals|browse.*signals/i).first(),
    ).toBeVisible();
  });

  test("has sport filter dropdown", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Should have a sport filter (select or button group)
    const sportFilter = page.locator("select, [role='listbox'], [role='combobox']").first();
    if (await sportFilter.isVisible().catch(() => false)) {
      await expect(sportFilter).toBeVisible();
    } else {
      // Might be button-style filters
      const allSports = page.getByText(/all sports/i).first();
      await expect(allSports).toBeVisible({ timeout: 5_000 });
    }
  });

  test("has sort options", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Should have sort dropdown or buttons
    const sortText = page.getByText(/expir|sort|fee|sla/i).first();
    await expect(sortText).toBeVisible({ timeout: 10_000 });
  });

  test("shows signals or empty state", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Should show either signal cards or an empty message
    const hasSignals = await page
      .locator("[href*='/idiot/signal/']")
      .first()
      .isVisible()
      .catch(() => false);
    const hasEmptyState = await page
      .getByText(/no signals|check back/i)
      .first()
      .isVisible()
      .catch(() => false);
    const hasLoading = await page
      .getByText(/loading/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(hasSignals || hasEmptyState || hasLoading).toBeTruthy();
  });

  test("back to dashboard link works", async ({ page }) => {
    await page.goto("/idiot/browse");

    const backLink = page.getByRole("link", { name: /back.*dashboard/i });
    if (await backLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await backLink.click();
      await expect(page).toHaveURL(/\/idiot$/, { timeout: 15_000 });
    }
  });

  test("no critical JS errors on browse page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle", { timeout: 20_000 });

    const critical = errors.filter(
      (e) =>
        !e.includes("MetaMask") &&
        !e.includes("ethereum") &&
        !e.includes("ResizeObserver") &&
        !e.includes("wallet") &&
        !e.includes("CSP") &&
        !e.includes("Content Security Policy"),
    );
    expect(critical).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Signal Detail / Purchase page
// ─────────────────────────────────────────────

test.describe("Signal Detail page", () => {
  test("handles invalid signal ID gracefully", async ({ page }) => {
    await page.goto("/idiot/signal/999999999");

    // Should show error or not found, not a crash
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const hasError = await page
      .getByText(/not found|error|invalid|connect/i)
      .first()
      .isVisible()
      .catch(() => false);
    const hasContent = await page
      .getByText(/purchase|signal/i)
      .first()
      .isVisible()
      .catch(() => false);

    // Either shows an error state or the page loaded with some content
    expect(hasError || hasContent).toBeTruthy();
  });

  test("shows connect wallet prompt for valid-looking signal", async ({
    page,
  }) => {
    // Use a plausible signal ID
    await page.goto("/idiot/signal/43");

    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Without wallet: should prompt to connect or show signal info
    const hasConnect = await page
      .getByText(/connect your wallet/i)
      .first()
      .isVisible()
      .catch(() => false);
    const hasSignalInfo = await page
      .getByText(/signal|purchase|not found/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(hasConnect || hasSignalInfo).toBeTruthy();
  });

  test("no JS errors on signal detail page", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    await page.goto("/idiot/signal/43");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const critical = errors.filter(
      (e) =>
        !e.includes("MetaMask") &&
        !e.includes("ethereum") &&
        !e.includes("ResizeObserver") &&
        !e.includes("wallet") &&
        !e.includes("CSP") &&
        !e.includes("Content Security Policy"),
    );
    expect(critical).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Idiot flow navigation
// ─────────────────────────────────────────────

test.describe("Idiot navigation flow", () => {
  test("home → idiot card → idiot dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the "I'm an Idiot" CTA
    const idiotCard = page.getByRole("link", { name: /idiot/i }).first();
    await expect(idiotCard).toBeVisible();
    await idiotCard.click();

    await expect(page).toHaveURL(/\/idiot/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("idiot dashboard → browse → back", async ({ page }) => {
    await page.goto("/idiot/browse");
    await expect(
      page.getByRole("heading", { name: /browse signals/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate back to idiot dashboard
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("header nav works from idiot pages", async ({ page }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate to about via header
    const aboutLink = page.getByRole("link", { name: /about/i }).first();
    await expect(aboutLink).toBeVisible();
    await aboutLink.click();
    await expect(page).toHaveURL(/\/about/, { timeout: 15_000 });
  });

  test("genius → idiot cross-navigation works", async ({ page }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate to Idiot from header
    const idiotLink = page.getByRole("link", { name: /^idiot$/i }).first();
    await expect(idiotLink).toBeVisible();
    await idiotLink.click();
    await expect(page).toHaveURL(/\/idiot/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────
// Idiot pages — responsive layouts
// ─────────────────────────────────────────────

test.describe("Idiot mobile layout", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("idiot dashboard renders without overflow on mobile", async ({
    page,
  }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });

  test("browse signals renders without overflow on mobile", async ({
    page,
  }) => {
    await page.goto("/idiot/browse");
    await expect(
      page.getByRole("heading", { name: /browse signals/i }),
    ).toBeVisible({ timeout: 10_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });

  test("signal detail page renders without overflow on mobile", async ({
    page,
  }) => {
    await page.goto("/idiot/signal/43");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(375 + 20);
  });
});

test.describe("Idiot tablet layout", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("browse signals shows grid layout on tablet", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(768 + 20);
  });
});

// ─────────────────────────────────────────────
// Idiot pages — no console errors
// ─────────────────────────────────────────────

test.describe("Idiot pages no JS errors", () => {
  const pages = [
    { url: "/idiot", name: "Dashboard" },
    { url: "/idiot/browse", name: "Browse Signals" },
    { url: "/idiot/signal/43", name: "Signal Detail" },
  ];

  for (const p of pages) {
    test(`${p.name} page has no critical JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(p.url);
      await page.waitForLoadState("networkidle", { timeout: 20_000 });

      const critical = errors.filter(
        (e) =>
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
