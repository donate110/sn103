import { test, expect } from "@playwright/test";
import {
  humanDelay,
  humanScroll,
  scrollToTop,
  waitForIdle,
} from "../helpers/human";
import { landOnSite, clickNav, clickLink } from "../helpers/navigate";

/**
 * Visitor Journey: Anonymous user browses djinn.gg
 *
 * Simulates a first-time visitor who lands on the homepage,
 * reads content, explores different pages via the navigation,
 * and checks out the leaderboard and docs. No wallet needed.
 *
 * Single page.goto() at the start; everything else is clicks.
 */

const BASE_URL = process.env.UX_BASE_URL ?? "https://djinn.gg";

test.describe("Visitor Journey", () => {
  test.describe.configure({ mode: "serial" });

  test("browse the site like a first-time visitor", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      if (
        err.message.includes("hydrat") ||
        err.message.includes("ChunkLoadError") ||
        err.message.includes("ResizeObserver") ||
        err.message.includes("Minified React error #418") ||
        err.message.includes("Minified React error #422") ||
        err.message.includes("Minified React error #423") ||
        err.message.includes("Minified React error #425")
      )
        return;
      errors.push(err.message);
    });

    // ── Step 1: Land on homepage ──────────────────────────────────
    await landOnSite(page, BASE_URL);

    await expect(page).toHaveTitle(/djinn/i, { timeout: 10_000 });
    // Homepage should have key sections visible
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    await humanScroll(page);
    await humanDelay(page, 2000, 4000);

    // ── Step 2: Browse to Genius page ────────────────────────────
    await clickNav(page, "Genius");

    await expect(page).toHaveURL(/\/genius/, { timeout: 10_000 });
    // Should see a prompt to connect wallet or the dashboard
    const geniusContent = page
      .getByText(/connect your wallet/i)
      .or(page.getByRole("heading", { name: /genius/i }));
    await expect(geniusContent.first()).toBeVisible({ timeout: 10_000 });

    await humanScroll(page);
    await humanDelay(page);

    // ── Step 3: Browse to Idiot page ─────────────────────────────
    await clickNav(page, "Idiot");

    await expect(page).toHaveURL(/\/idiot/, { timeout: 10_000 });
    const idiotContent = page
      .getByText(/connect your wallet/i)
      .or(page.getByRole("heading", { name: /idiot/i }));
    await expect(idiotContent.first()).toBeVisible({ timeout: 10_000 });

    await humanScroll(page);
    await humanDelay(page);

    // ── Step 4: Check the Leaderboard ────────────────────────────
    await clickNav(page, "Leaderboard");

    await expect(page).toHaveURL(/\/leaderboard/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: /leaderboard/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Should show either data or an empty state
    const leaderboardContent = page
      .getByText(/quality score|no geniuses|ranking/i)
      .first();
    await expect(leaderboardContent).toBeVisible({ timeout: 10_000 });

    await humanScroll(page);
    await humanDelay(page);

    // ── Step 5: Check the Network page ───────────────────────────
    await clickNav(page, "Network");

    await expect(page).toHaveURL(/\/network/, { timeout: 10_000 });
    await humanDelay(page, 1500, 3000);

    // ── Step 6: Read the Docs ────────────────────────────────────
    await clickNav(page, "Docs");

    await expect(page).toHaveURL(/\/docs/, { timeout: 10_000 });
    await humanScroll(page);
    await humanDelay(page, 2000, 4000);

    // ── Step 7: Check About page ─────────────────────────────────
    await clickNav(page, "About");

    await expect(page).toHaveURL(/\/about/, { timeout: 10_000 });
    await humanScroll(page);
    await humanDelay(page);

    // ── Step 8: Return home ──────────────────────────────────────
    await clickNav(page, "Home");

    await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });

    // ── Final: Report JS errors (non-blocking, logged as annotations) ─
    // Site errors are captured and reported but don't fail the journey.
    // The journey succeeds if navigation completed; errors are tracked
    // separately for triage.
    if (errors.length > 0) {
      for (const e of errors) {
        test.info().annotations.push({ type: "js-error", description: e });
      }
      console.log(`[visitor] ${errors.length} JS error(s) observed:`, errors);
    }
  });
});
