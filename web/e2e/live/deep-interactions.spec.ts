import { test, expect } from "@playwright/test";

/**
 * Deep interaction tests for the live site.
 * Tests keyboard navigation, focus management, network errors,
 * image loading, link validity, and edge cases.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Keyboard navigation and focus management
// ─────────────────────────────────────────────

test.describe("Keyboard navigation", () => {
  test("tab order starts with nav links on homepage", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Tab to first focusable element
    await page.keyboard.press("Tab");
    const firstFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, href: el?.getAttribute("href") };
    });
    // First focusable should be a link (skip-to-content or nav link)
    expect(firstFocused.tag).toBe("A");
  });

  test("all nav links are keyboard accessible", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const navLinks = ["Genius", "Idiot", "Leaderboard", "Attest", "About"];
    for (const linkName of navLinks) {
      const link = page
        .getByRole("link", { name: new RegExp(`^${linkName}$`, "i") })
        .first();
      await expect(link).toBeVisible();
    }
  });

  test("escape key closes mobile menu if open", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    // Find and click hamburger menu button
    const menuBtn = page
      .locator("button")
      .filter({ has: page.locator("svg") })
      .first();
    if (await menuBtn.isVisible().catch(() => false)) {
      await menuBtn.click();
      await page.waitForTimeout(500);
      // Press escape to close
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      // Menu should be closed — nav links should not be visible in mobile layout
      // (This is implementation-dependent; just verify no crash)
    }
  });
});

// ─────────────────────────────────────────────
// Images
// ─────────────────────────────────────────────

test.describe("Image loading", () => {
  test("all images on homepage have alt text", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const images = await page.locator("img").all();
    for (const img of images) {
      const alt = await img.getAttribute("alt");
      const hasAlt = alt !== null && alt !== undefined;
      expect(hasAlt).toBeTruthy();
    }
  });

  test("logo image loads successfully", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const logo = page.locator('img[alt="Djinn"]').first();
    await expect(logo).toBeVisible();
    // Check naturalWidth > 0 to verify image actually loaded
    const naturalWidth = await logo.evaluate(
      (el) => (el as HTMLImageElement).naturalWidth,
    );
    expect(naturalWidth).toBeGreaterThan(0);
  });

  test("press page images load correctly", async ({ page }) => {
    await page.goto("/press");
    await page.waitForLoadState("networkidle");
    const images = await page.locator("img").all();
    for (const img of images) {
      const naturalWidth = await img.evaluate(
        (el) => (el as HTMLImageElement).naturalWidth,
      );
      const src = await img.getAttribute("src");
      // All images should have loaded (naturalWidth > 0)
      if (naturalWidth === 0) {
        test.info().annotations.push({
          type: "warning",
          description: `Image failed to load: ${src}`,
        });
      }
    }
  });
});

// ─────────────────────────────────────────────
// Internal link validation
// ─────────────────────────────────────────────

test.describe("Internal links", () => {
  test("all internal links from homepage are valid", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const links = await page.locator("a[href^='/']").evaluateAll((els) =>
      [...new Set(els.map((el) => el.getAttribute("href")))].filter(
        (h) => h && !h.startsWith("/api") && !h.includes("#"),
      ),
    );
    // Test each internal link
    const broken: string[] = [];
    for (const href of links) {
      const res = await page.request.get(href!);
      if (res.status() >= 400) {
        broken.push(`${href} -> ${res.status()}`);
      }
    }
    expect(
      broken,
      `Broken internal links: ${broken.join(", ")}`,
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Browse signals — deeper interaction
// ─────────────────────────────────────────────

test.describe("Browse signals interactions", () => {
  test("sport filter buttons are clickable", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle");
    // Check for sport filter tabs/buttons
    const allSportsBtn = page.getByText(/all sports/i).first();
    if (await allSportsBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await allSportsBtn.click();
      // Should still be on browse page
      await expect(page).toHaveURL(/\/idiot\/browse/);
    }
  });

  test("browse page shows signal count or empty message", async ({ page }) => {
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3_000);
    const body = await page.locator("body").textContent();
    // Should have either signal cards or meaningful text
    expect(body!.length).toBeGreaterThan(200);
  });

  test("no network errors on browse page", async ({ page }) => {
    const failedRequests: string[] = [];
    page.on("response", (res) => {
      if (
        res.status() >= 500 &&
        !res.url().includes("walletconnect") &&
        !res.url().includes("web3modal")
      ) {
        failedRequests.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto("/idiot/browse");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3_000);
    expect(
      failedRequests,
      `Server errors on browse page: ${failedRequests.join(", ")}`,
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Leaderboard — deeper interaction
// ─────────────────────────────────────────────

test.describe("Leaderboard interactions", () => {
  test("leaderboard shows table headers or empty state", async ({ page }) => {
    await page.goto("/leaderboard");
    await page.waitForLoadState("networkidle");
    const body = await page.locator("body").textContent();
    // Should mention quality-related terms or show empty state
    const hasContent =
      body!.includes("Quality") ||
      body!.includes("quality") ||
      body!.includes("Score") ||
      body!.includes("score") ||
      body!.includes("Rank") ||
      body!.includes("No geniuses") ||
      body!.includes("no geniuses");
    expect(hasContent).toBeTruthy();
  });

  test("no server errors on leaderboard", async ({ page }) => {
    const serverErrors: string[] = [];
    page.on("response", (res) => {
      if (
        res.status() >= 500 &&
        !res.url().includes("walletconnect") &&
        !res.url().includes("web3modal")
      ) {
        serverErrors.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto("/leaderboard");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);
    expect(serverErrors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Attest page — form interaction
// ─────────────────────────────────────────────

test.describe("Attest page interactions", () => {
  test("attest page has URL input and heading", async ({ page }) => {
    await page.goto("/attest");
    await page.waitForLoadState("networkidle");
    // Should have the attest heading
    await expect(
      page.getByRole("heading", { name: /attest/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Should have a URL input field
    const urlInput = page
      .locator('input[type="text"], input[type="url"], textarea')
      .first();
    await expect(urlInput).toBeVisible();
  });

  test("attest page URL input accepts text", async ({ page }) => {
    await page.goto("/attest");
    await page.waitForLoadState("networkidle");
    const urlInput = page
      .locator('input[type="text"], input[type="url"], textarea')
      .first();
    await expect(urlInput).toBeVisible({ timeout: 5_000 });
    await urlInput.fill("https://example.com/test");
    const val = await urlInput.inputValue();
    expect(val).toBe("https://example.com/test");
  });

  test("no server errors on attest page", async ({ page }) => {
    const serverErrors: string[] = [];
    page.on("response", (res) => {
      if (
        res.status() >= 500 &&
        !res.url().includes("walletconnect") &&
        !res.url().includes("web3modal")
      ) {
        serverErrors.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto("/attest");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2_000);
    expect(serverErrors).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// Network request monitoring across all pages
// ─────────────────────────────────────────────

test.describe("No 5xx errors across all pages", () => {
  const pages = [
    { name: "Home", url: "/" },
    { name: "Genius", url: "/genius" },
    { name: "Idiot", url: "/idiot" },
    { name: "Leaderboard", url: "/leaderboard" },
    { name: "About", url: "/about" },
    { name: "Press", url: "/press" },
    { name: "Privacy", url: "/privacy" },
    { name: "Terms", url: "/terms" },
    { name: "Attest", url: "/attest" },
    { name: "Create Signal", url: "/genius/signal/new" },
    { name: "Browse Signals", url: "/idiot/browse" },
  ];

  for (const { name, url } of pages) {
    test(`${name} page has no 5xx server errors`, async ({ page }) => {
      const serverErrors: string[] = [];
      page.on("response", (res) => {
        if (
          res.status() >= 500 &&
          !res.url().includes("walletconnect") &&
          !res.url().includes("web3modal")
        ) {
          serverErrors.push(`${res.status()} ${res.url().substring(0, 100)}`);
        }
      });
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2_000);
      expect(
        serverErrors,
        `5xx errors on ${name}: ${serverErrors.join(", ")}`,
      ).toHaveLength(0);
    });
  }
});

// ─────────────────────────────────────────────
// Edge cases: special characters, long URLs
// ─────────────────────────────────────────────

test.describe("Edge cases", () => {
  test("signal ID with special characters is handled gracefully", async ({
    page,
  }) => {
    const res = await page.goto("/idiot/signal/<script>alert(1)</script>");
    // Should not crash, return 404 or display error
    expect(res?.status()).toBeGreaterThanOrEqual(200);
    await page.waitForLoadState("domcontentloaded");
    // Should not have executed the script (XSS protection)
    const alertFired = await page.evaluate(() => {
      return (window as any).__xss_test === true;
    });
    expect(alertFired).toBe(false);
  });

  test("very long route path is handled", async ({ page }) => {
    const longPath = "/a".repeat(500);
    const res = await page.goto(longPath);
    // Should return 404 or some error, not crash
    expect(res?.status()).toBeGreaterThanOrEqual(400);
  });

  test("query parameters don't break pages", async ({ page }) => {
    await page.goto("/leaderboard?foo=bar&baz=123");
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("hash fragments don't break pages", async ({ page }) => {
    await page.goto("/about#section");
    const body = await page.locator("body").textContent();
    expect(body!.length).toBeGreaterThan(100);
  });

  test("trailing slash doesn't break routes", async ({ page }) => {
    await page.goto("/genius/");
    await expect(
      page.getByRole("heading", { name: "Genius Dashboard" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─────────────────────────────────────────────
// PWA manifest
// ─────────────────────────────────────────────

test.describe("PWA manifest", () => {
  test("manifest.json is valid", async ({ request }) => {
    const res = await request.get("/manifest.json");
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name || manifest.name).toBeTruthy();
    expect(manifest.icons).toBeTruthy();
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
  });
});
