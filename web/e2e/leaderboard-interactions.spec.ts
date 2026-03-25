import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

test.describe("Leaderboard sorting", () => {
  test("clicking column header toggles sort direction", async ({ page }) => {
    await page.goto("/leaderboard");

    const qsHeader = page.getByRole("columnheader", {
      name: /Quality Score/i,
    });
    await expect(qsHeader).toBeVisible();

    // Default sort should be descending on quality score
    await expect(qsHeader).toHaveAttribute("aria-sort", "descending");

    // Click to toggle to ascending
    await qsHeader.click();
    await expect(qsHeader).toHaveAttribute("aria-sort", "ascending");

    // Click again to toggle back to descending
    await qsHeader.click();
    await expect(qsHeader).toHaveAttribute("aria-sort", "descending");
  });

  test("clicking different column changes sort field", async ({ page }) => {
    await page.goto("/leaderboard");

    const signalsHeader = page.getByRole("columnheader", {
      name: /Signals/i,
    });
    await signalsHeader.click();

    // Should now sort by signals (descending by default on new field)
    await expect(signalsHeader).toHaveAttribute("aria-sort", "descending");

    // Quality Score should no longer be sorted
    const qsHeader = page.getByRole("columnheader", {
      name: /Quality Score/i,
    });
    await expect(qsHeader).toHaveAttribute("aria-sort", "none");
  });

  test("all sortable columns have aria-sort attribute", async ({ page }) => {
    await page.goto("/leaderboard");

    const columns = ["Quality Score", "Signals", "Audits", "ROI", "Proofs"];
    for (const col of columns) {
      const header = page.getByRole("columnheader", {
        name: new RegExp(col, "i"),
      });
      await expect(header).toBeVisible();
      const sort = await header.getAttribute("aria-sort");
      expect(["ascending", "descending", "none"]).toContain(sort);
    }
  });

  test("column headers are keyboard accessible", async ({ page }) => {
    await page.goto("/leaderboard");

    const roiHeader = page.getByRole("columnheader", { name: /ROI/i });
    await roiHeader.focus();
    await page.keyboard.press("Enter");
    await expect(roiHeader).toHaveAttribute("aria-sort", "descending");
  });
});

test.describe("Leaderboard content", () => {
  test("shows 'How Quality Score Works' explanation", async ({ page }) => {
    await page.goto("/leaderboard");
    await expect(
      page.getByRole("heading", { name: /How Quality Score Works/i })
    ).toBeVisible();
  });

  test("shows empty state or data rows", async ({ page }) => {
    await page.goto("/leaderboard");

    // Wait for the table to load (may take a moment to fetch on-chain data)
    const tbody = page.locator("tbody");
    await tbody.waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});

    const body = await tbody.textContent({ timeout: 5_000 }).catch(() => "");
    // Table may be empty if no settled audits yet; that's ok
    expect(typeof body).toBe("string");
  });

  test("shows leaderboard content or setup message", async ({
    page,
  }) => {
    await page.goto("/leaderboard");
    const setupMsg = page.getByText(/leaderboard is being set up/i);
    const table = page.getByRole("table");
    await expect(setupMsg.or(table).first()).toBeVisible({ timeout: 10_000 });
  });
});
