import { test, expect } from "@playwright/test";

/**
 * UI edge case tests — exercises error states, edge cases,
 * responsive layouts, console errors, and navigation robustness.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Console error monitoring
// ─────────────────────────────────────────────

test.describe("No console errors on page load", () => {
  const pages = [
    { name: "Home", url: "/" },
    { name: "Genius Dashboard", url: "/genius" },
    { name: "Idiot Dashboard", url: "/idiot" },
    { name: "Leaderboard", url: "/leaderboard" },
    { name: "About", url: "/about" },
    { name: "Create Signal", url: "/genius/signal/new" },
    { name: "Track Record", url: "/genius/track-record" },
  ];

  for (const { name, url } of pages) {
    test(`${name} (${url}) loads without JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));

      await page.goto(url, { timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 30_000 });

      // Filter out known benign errors (e.g., missing wallet)
      const realErrors = errors.filter(
        (e) =>
          !e.includes("wallet") &&
          !e.includes("MetaMask") &&
          !e.includes("ethereum") &&
          !e.includes("ResizeObserver"),
      );
      expect(realErrors).toHaveLength(0);
    });
  }
});

// ─────────────────────────────────────────────
// Beta gate enforcement
// ─────────────────────────────────────────────

test.describe("Beta gate", () => {
  test("page loads with or without beta password", async ({ page }) => {
    // Without beta access set, page should either show beta gate or content
    // (depends on whether NEXT_PUBLIC_BETA_PASSWORD is set in the build)
    await page.goto("/genius");
    await page.waitForLoadState("networkidle");
    const body = await page.locator("body").textContent();
    // Should have some content — not a blank page
    expect(body!.length).toBeGreaterThan(50);
  });

  test("with beta access flag, genius dashboard renders", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("djinn-beta-access", "true");
    });
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ─────────────────────────────────────────────
// 404 and error pages
// ─────────────────────────────────────────────

test.describe("Error pages", () => {
  test("unknown route returns 404 status", async ({ page }) => {
    const res = await page.goto("/totally-nonexistent-page-xyz");
    expect(res?.status()).toBe(404);
  });

  test("unknown genius signal ID shows error or 404", async ({ page }) => {
    const res = await page.goto("/genius/signal/nonexistent-signal-abc");
    // Should either 404 or show an error state
    if (res?.status() === 200) {
      // If 200, it should render an error/not-found message
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").textContent();
      const hasError =
        body!.includes("not found") ||
        body!.includes("Not Found") ||
        body!.includes("error") ||
        body!.includes("connect");
      expect(hasError).toBeTruthy();
    }
  });

  test("unknown idiot signal ID shows error or 404", async ({ page }) => {
    const res = await page.goto("/idiot/signal/nonexistent-signal-abc");
    if (res?.status() === 200) {
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").textContent();
      const hasError =
        body!.includes("not found") ||
        body!.includes("Not Found") ||
        body!.includes("error") ||
        body!.includes("connect");
      expect(hasError).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────
// Mobile responsive layouts
// ─────────────────────────────────────────────

test.describe("Mobile responsive (375×667)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  const mobilePages = [
    { name: "Home", url: "/", heading: "DJINN" },
    { name: "Genius", url: "/genius", heading: "Genius Dashboard" },
    { name: "Idiot", url: "/idiot", heading: "Idiot Dashboard" },
    { name: "Leaderboard", url: "/leaderboard", heading: null },
    { name: "About", url: "/about", heading: null },
    { name: "Create Signal", url: "/genius/signal/new", heading: null },
  ];

  for (const { name, url, heading } of mobilePages) {
    test(`${name} renders without horizontal overflow`, async ({ page }) => {
      await page.goto(url);
      await page.waitForLoadState("domcontentloaded");

      if (heading) {
        await expect(
          page
            .getByRole("heading", {
              name: typeof heading === "string" ? heading : undefined,
            })
            .or(page.getByText(heading))
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      }

      const scrollWidth = await page.evaluate(
        () => document.body.scrollWidth,
      );
      // Allow small tolerance for scrollbars etc.
      expect(scrollWidth).toBeLessThanOrEqual(375 + 30);
    });
  }
});

test.describe("Tablet responsive (768×1024)", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("home page renders on tablet", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    const scrollWidth = await page.evaluate(
      () => document.body.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(768 + 30);
  });

  test("leaderboard table renders on tablet", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();

    const scrollWidth = await page.evaluate(
      () => document.body.scrollWidth,
    );
    expect(scrollWidth).toBeLessThanOrEqual(768 + 30);
  });
});

// ─────────────────────────────────────────────
// Navigation edge cases
// ─────────────────────────────────────────────

test.describe("Navigation edge cases", () => {
  test("back/forward navigation preserves state", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();

    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();

    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();
  });

  test("rapid navigation between pages doesn't crash", async ({ page }) => {
    const urls = ["/", "/genius", "/idiot", "/leaderboard", "/about", "/"];
    for (const url of urls) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    // Final page should render correctly
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();
  });

  test("direct URL to create signal page works", async ({ page }) => {
    await page.goto("/genius/signal/new");
    // Should render the create signal page or connect wallet prompt
    // Use auto-waiting locator instead of snapshot textContent (client-side hydration timing)
    await expect(
      page.getByText(/Create Signal|Connect your wallet/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("direct URL to track record page works", async ({ page }) => {
    await page.goto("/genius/track-record");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(50);
  });
});

// ─────────────────────────────────────────────
// Content checks
// ─────────────────────────────────────────────

test.describe("Content integrity", () => {
  test("home page has Genius and Idiot links", async ({ page }) => {
    await page.goto("/");
    const geniusLink = page.getByRole("link", { name: /genius/i }).first();
    const idiotLink = page.getByRole("link", { name: /idiot/i }).first();
    await expect(geniusLink).toBeVisible();
    await expect(idiotLink).toBeVisible();
  });

  test("genius dashboard shows connect wallet prompt (no wallet)", async ({
    page,
  }) => {
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();
    // Without wallet, should prompt to connect
    await expect(
      page.getByText(/connect/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("idiot dashboard shows connect wallet prompt (no wallet)", async ({
    page,
  }) => {
    await page.goto("/idiot");
    await expect(
      page.getByRole("heading", { name: "Idiot Dashboard" }),
    ).toBeVisible();
    await expect(
      page.getByText(/connect/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("leaderboard page renders table or empty state", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();
    // Should have either a table or an empty state message
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(100);
  });

  test("about page has substantial content", async ({ page }) => {
    await page.goto("/about");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(200);
    // Should mention protocol concepts
    expect(
      body!.includes("Genius") ||
        body!.includes("signal") ||
        body!.includes("Djinn") ||
        body!.includes("protocol"),
    ).toBeTruthy();
  });
});

// ─────────────────────────────────────────────
// Performance checks
// ─────────────────────────────────────────────

test.describe("Performance", () => {
  test("home page loads within 10 seconds", async ({ page }) => {
    const start = Date.now();
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "DJINN" }),
    ).toBeVisible();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10000);
  });

  test("genius dashboard loads within 8 seconds", async ({ page }) => {
    const start = Date.now();
    await page.goto("/genius");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);
  });

  test("leaderboard loads within 8 seconds", async ({ page }) => {
    const start = Date.now();
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);
  });
});

// ─────────────────────────────────────────────
// Accessibility basics
// ─────────────────────────────────────────────

test.describe("Accessibility basics", () => {
  test("pages have proper heading hierarchy", async ({ page }) => {
    await page.goto("/");
    // Wait for client-side hydration before counting headings
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10_000 });
    const h1Count = await page.locator("h1").count();
    expect(h1Count).toBeGreaterThanOrEqual(1);
  });

  test("links have accessible text", async ({ page }) => {
    await page.goto("/");
    const links = await page.locator("a").all();
    for (const link of links.slice(0, 20)) {
      // Each link should have text content or an aria-label
      const text = await link.textContent();
      const ariaLabel = await link.getAttribute("aria-label");
      const title = await link.getAttribute("title");
      expect(
        (text && text.trim().length > 0) || ariaLabel || title,
      ).toBeTruthy();
    }
  });

  test("form inputs have labels or aria-labels", async ({ page }) => {
    await page.goto("/genius/signal/new");
    await page.waitForLoadState("networkidle");
    const inputs = await page.locator("input").all();
    for (const input of inputs.slice(0, 10)) {
      const id = await input.getAttribute("id");
      const ariaLabel = await input.getAttribute("aria-label");
      const placeholder = await input.getAttribute("placeholder");
      const type = await input.getAttribute("type");

      // Hidden inputs are fine without labels
      if (type === "hidden") continue;

      // Should have some form of label
      const hasLabel = id
        ? (await page.locator(`label[for="${id}"]`).count()) > 0
        : false;
      expect(
        hasLabel || ariaLabel || placeholder,
      ).toBeTruthy();
    }
  });
});
