import type { Page, Locator } from "@playwright/test";

/**
 * Human-like browser interaction helpers.
 *
 * These functions add realistic timing and behavior to avoid bot detection
 * and ensure tests exercise the same code paths real users hit.
 */

/** Random integer between min and max (inclusive). */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Wait a random amount of time, like a human reading or thinking. */
export async function humanDelay(
  page: Page,
  minMs = 800,
  maxMs = 2500,
): Promise<void> {
  await page.waitForTimeout(randInt(minMs, maxMs));
}

/** Short pause between rapid actions (clicking a button after reading). */
export async function quickPause(page: Page): Promise<void> {
  await page.waitForTimeout(randInt(300, 800));
}

/** Scroll down the page a bit, like a user scanning content. */
export async function humanScroll(page: Page): Promise<void> {
  const scrollAmount = randInt(200, 600);
  await page.mouse.wheel(0, scrollAmount);
  await page.waitForTimeout(randInt(500, 1200));
}

/** Scroll to the top of the page. */
export async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await page.waitForTimeout(randInt(300, 600));
}

/**
 * Click an element with human-like behavior:
 * hover first, brief pause, then click.
 * Falls back to force-click if an overlay intercepts pointer events.
 */
export async function humanClick(locator: Locator): Promise<void> {
  try {
    await locator.hover({ timeout: 5_000 });
    const page = locator.page();
    await page.waitForTimeout(randInt(100, 400));
    await locator.click({ timeout: 5_000 });
  } catch {
    // Overlay or sticky element intercepting. Use force click.
    await locator.click({ force: true });
  }
}

/**
 * Type text character by character with variable delays,
 * like a real person typing.
 */
export async function humanType(
  locator: Locator,
  text: string,
): Promise<void> {
  await locator.click();
  for (const char of text) {
    await locator.page().keyboard.type(char, { delay: randInt(50, 150) });
  }
}

/**
 * Wait for the page to reach a stable idle state.
 * Useful after navigation or data loading.
 */
export async function waitForIdle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Take a named screenshot for debugging (only in headed mode or on failure).
 */
export async function snapshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `test-results/ux-${name}-${Date.now()}.png`,
    fullPage: false,
  });
}
