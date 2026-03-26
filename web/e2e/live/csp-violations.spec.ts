import { test, expect } from "@playwright/test";

/**
 * Test for Content-Security-Policy violations.
 * Monitors CSP reports to catch blocked resources.
 */

test.describe("CSP violation monitoring", () => {
  const pages = [
    { name: "Home", url: "/" },
    { name: "Genius", url: "/genius" },
    { name: "Idiot", url: "/idiot" },
    { name: "Leaderboard", url: "/leaderboard" },
    { name: "Browse", url: "/idiot/browse" },
    { name: "Create Signal", url: "/genius/signal/new" },
    { name: "Attest", url: "/attest" },
  ];

  for (const { name, url } of pages) {
    test(`${name} has no critical CSP violations`, async ({ page }) => {
      const cspViolations: string[] = [];

      // Listen for securitypolicyviolation events via page evaluate
      await page.addInitScript(() => {
        (window as any).__cspViolations = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          (window as any).__cspViolations.push({
            blockedURI: e.blockedURI,
            violatedDirective: e.violatedDirective,
            effectiveDirective: e.effectiveDirective,
            originalPolicy: e.originalPolicy?.substring(0, 200),
          });
        });
      });

      // Also collect console errors related to CSP
      page.on("console", (msg) => {
        const text = msg.text();
        if (
          text.includes("Content Security Policy") ||
          text.includes("Refused to") ||
          text.includes("blocked by CSP")
        ) {
          // Ignore known benign CSP violations
          if (
            text.includes("walletconnect") ||
            text.includes("web3modal") ||
            text.includes("cloudflare")
          ) {
            return;
          }
          cspViolations.push(text.substring(0, 200));
        }
      });

      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3_000);

      // Get violations from the page
      const pageViolations = await page.evaluate(
        () => (window as any).__cspViolations || [],
      );

      // Filter out known benign violations (wallet-related, third-party)
      const criticalViolations = pageViolations.filter(
        (v: any) =>
          !v.blockedURI?.includes("walletconnect") &&
          !v.blockedURI?.includes("web3modal") &&
          !v.blockedURI?.includes("cloudflare") &&
          !v.blockedURI?.includes("coinbase") &&
          v.blockedURI !== "inline" && // inline scripts/styles are allowed
          v.blockedURI !== "eval" && // eval is allowed
          v.blockedURI !== "",
      );

      if (criticalViolations.length > 0) {
        test.info().annotations.push({
          type: "csp-violations",
          description: JSON.stringify(criticalViolations),
        });
      }

      // Allow some benign violations but flag critical ones
      expect(
        criticalViolations,
        `Critical CSP violations on ${name}: ${JSON.stringify(criticalViolations)}`,
      ).toHaveLength(0);
    });
  }
});
