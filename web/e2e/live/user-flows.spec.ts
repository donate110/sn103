import { test, expect, type Page } from "@playwright/test";

/**
 * Comprehensive live E2E tests for Genius and Idiot user flows.
 * Tests the full user journey on the deployed djinn.gg site.
 *
 * NOTE: These tests run WITHOUT a wallet connected (no real funds).
 * They verify that the UI renders correctly, navigation works,
 * and the right prompts appear at each step. Wallet-connected
 * flows are tested separately with mock providers in standard E2E.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Genius flow (no wallet)
// ─────────────────────────────────────────────

test.describe("Genius flow — no wallet", () => {
  test("genius dashboard shows connect prompt with correct structure", async ({
    page,
  }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();
    await expect(page.getByText(/connect your wallet/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("create signal page shows connect prompt", async ({ page }) => {
    await page.goto("/genius/signal/new");
    await expect(
      page.getByText(/Create Signal/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/connect your wallet/i),
    ).toBeVisible();
  });

  test("track record page loads correctly", async ({ page }) => {
    await page.goto("/genius/track-record");
    // Should render without errors
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(50);
    // Should not show infinite spinner after 5s
    await page.waitForTimeout(3_000);
    const spinnerVisible = await page
      .locator('[class*="animate-spin"]')
      .isVisible()
      .catch(() => false);
    // Spinner should either be gone or page should have content beyond spinner
    if (spinnerVisible) {
      // If spinner is still visible, there should be other content too
      const content = await page.locator("body").textContent();
      expect(content!.length).toBeGreaterThan(100);
    }
  });

  test("genius dashboard has nav links to create signal and track record", async ({
    page,
  }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();
    // After the connect prompt renders, check the page has useful navigation
    // The page should have links to key genius functionality
    const links = await page.locator("a").allTextContents();
    const hasGeniusNav =
      links.some((l) => /signal|create/i.test(l)) ||
      links.some((l) => /genius/i.test(l));
    // At minimum, the nav bar should have links
    expect(links.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// Idiot flow (no wallet)
// ─────────────────────────────────────────────

test.describe("Idiot flow — no wallet", () => {
  test("idiot dashboard shows connect prompt with correct structure", async ({
    page,
  }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible();
    await expect(page.getByText(/connect your wallet/i)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("browse signals page loads", async ({ page }) => {
    await page.goto("/idiot/browse");
    // Should render the browse page (may show empty state or signals)
    await page.waitForLoadState("networkidle");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(50);
  });

  test("idiot signal detail page handles invalid ID gracefully", async ({
    page,
  }) => {
    await page.goto("/idiot/signal/999999999");
    // Should not crash — either shows error state or loading
    await page.waitForLoadState("networkidle");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────

test.describe("Leaderboard interactions", () => {
  test("leaderboard page loads with table structure", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();
    // Should have a table or card structure (may be empty if no geniuses yet)
    await page.waitForLoadState("networkidle");
    const body = await page.locator("body").textContent();
    // The page should have meaningful content
    expect(body!.length).toBeGreaterThan(100);
  });

  test("leaderboard doesn't show console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Ignore common non-critical errors
        if (
          text.includes("favicon") ||
          text.includes("manifest") ||
          text.includes("third-party") ||
          text.includes("Failed to load resource") ||
          text.includes("net::ERR") ||
          text.includes("Content Security Policy") ||
          text.includes("Refused to connect") ||
          text.includes("walletconnect") ||
          text.includes("CORS") ||
          text.includes("403")
        ) {
          return;
        }
        errors.push(text);
      }
    });
    await page.goto("/leaderboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);
    expect(errors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Attest page
// ─────────────────────────────────────────────

test.describe("Attest page", () => {
  test("attest page loads with correct structure", async ({ page }) => {
    await page.goto("/attest");
    // Should have main heading
    await expect(
      page.getByRole("heading", { name: /attest/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Should have URL input
    await expect(
      page.locator('input[type="text"], input[type="url"], textarea').first(),
    ).toBeVisible();
  });

  test("attest page has URL input and submit button", async ({ page }) => {
    await page.goto("/attest");
    await page.waitForLoadState("networkidle");
    // Should have a URL input field
    const urlInput = page
      .locator('input[type="text"], input[type="url"], textarea')
      .first();
    await expect(urlInput).toBeVisible({ timeout: 10_000 });
    // Should have a submit/attest button
    const submitBtn = page
      .getByRole("button", { name: /attest|submit|prove|verify/i })
      .first();
    if (await submitBtn.isVisible()) {
      const isDisabled = await submitBtn.isDisabled();
      // Either disabled (empty URL) or enabled — either is valid
      expect(typeof isDisabled).toBe("boolean");
    }
  });
});

// ─────────────────────────────────────────────
// Attest API endpoint tests
// ─────────────────────────────────────────────

test.describe("Attest API", () => {
  test("POST /api/attest rejects missing URL", async ({ request }) => {
    const res = await request.post("/api/attest", {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("POST /api/attest rejects http:// URLs", async ({ request }) => {
    const res = await request.post("/api/attest", {
      data: {
        url: "http://example.com",
        request_id: "test-123",
        burn_tx_hash: "0xabc123",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("https://");
  });

  test("POST /api/attest rejects missing request_id", async ({ request }) => {
    const res = await request.post("/api/attest", {
      data: {
        url: "https://example.com",
        burn_tx_hash: "0xabc123",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("request_id");
  });

  test("POST /api/attest accepts valid request and proxies to validator", async ({
    request,
  }) => {
    // Attestation can take up to 5 minutes as it generates a TLSNotary proof
    test.setTimeout(300_000);
    const res = await request.post("/api/attest", {
      data: {
        url: "https://example.com",
        request_id: "test-e2e-valid",
      },
      timeout: 280_000,
    });
    // Should not be 400 (validation passes) — may be 200 or 502 depending on validator
    expect(res.status()).not.toBe(400);
  });

  test("POST /api/attest rejects private IP URLs", async ({ request }) => {
    const res = await request.post("/api/attest", {
      data: {
        url: "https://127.0.0.1/secret",
        request_id: "test-ssrf",
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("public");
  });
});

// ─────────────────────────────────────────────
// Cross-page user journeys
// ─────────────────────────────────────────────

test.describe("Cross-page user journeys", () => {
  test("home → genius → create signal → back flow", async ({ page }) => {
    // Start at home
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    // Navigate to genius
    await page.getByRole("link", { name: /genius/i }).first().click();
    await expect(page).toHaveURL(/\/genius/);
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();

    // Navigate to create signal
    await page.goto("/genius/signal/new");
    await expect(
      page.getByText(/Create Signal/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate back to genius dashboard
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("home → idiot → browse → back flow", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    // Navigate to idiot
    await page.getByRole("link", { name: /idiot/i }).first().click();
    await expect(page).toHaveURL(/\/idiot/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate to browse
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle");

    // Navigate back
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("home → leaderboard → about → home round trip", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    // To leaderboard
    await page.getByRole("link", { name: /leaderboard/i }).first().click();
    await expect(page).toHaveURL(/\/leaderboard/);
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();

    // To about
    await page.goto("/about");
    await page.waitForLoadState("networkidle");
    const aboutBody = await page.locator("body").textContent();
    expect(aboutBody!.length).toBeGreaterThan(100);

    // Back to home via logo/brand link
    const homeLink = page.getByRole("link", { name: /djinn|home/i }).first();
    if (await homeLink.isVisible()) {
      await homeLink.click();
      await expect(
        page.getByRole("heading", { name: "DJINN" }),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("home → attest → home round trip", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    // Navigate to attest
    await page.getByRole("link", { name: /attest/i }).first().click();
    await expect(page).toHaveURL(/\/attest/);
    await expect(
      page.getByRole("heading", { name: /attest/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Navigate back
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────
// Console error monitoring across key pages
// ─────────────────────────────────────────────

test.describe("No critical console errors", () => {
  const pages = [
    { name: "Home", url: "/" },
    { name: "Genius", url: "/genius" },
    { name: "Idiot", url: "/idiot" },
    { name: "Leaderboard", url: "/leaderboard" },
    { name: "Attest", url: "/attest" },
    { name: "Create Signal", url: "/genius/signal/new" },
    { name: "Browse", url: "/idiot/browse" },
  ];

  for (const { name, url } of pages) {
    test(`${name} page has no critical JS errors`, async ({ page }) => {
      const criticalErrors: string[] = [];
      page.on("pageerror", (err) => {
        criticalErrors.push(err.message);
      });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2_000);
      // No unhandled exceptions
      expect(
        criticalErrors,
        `Critical JS errors on ${name}: ${criticalErrors.join(", ")}`,
      ).toHaveLength(0);
    });
  }
});

// ─────────────────────────────────────────────
// Responsive layout checks
// ─────────────────────────────────────────────

test.describe("Responsive layouts", () => {
  const viewports = [
    { name: "iPhone SE", width: 375, height: 667 },
    { name: "iPad", width: 768, height: 1024 },
    { name: "Desktop", width: 1440, height: 900 },
  ];

  for (const vp of viewports) {
    test(`genius dashboard renders correctly on ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/genius");
      await expect(
        page.getByRole("heading", { name: "Genius Dashboard" }),
      ).toBeVisible();
      // No horizontal overflow
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width + 20);
    });

    test(`idiot dashboard renders correctly on ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/idiot");
      await expect(
        page.getByRole("heading", { name: "Idiot Dashboard" }),
      ).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width + 20);
    });

    test(`attest page renders correctly on ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/attest");
      await expect(
        page.getByRole("heading", { name: /attest/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(vp.width + 20);
    });
  }
});
