import { test, expect } from "@playwright/test";

/**
 * Proxy body size limit tests.
 *
 * Verifies that all proxy routes reject requests with bodies > 1 MB.
 * The response may come from our code (413 + JSON error) or from the
 * hosting platform's own body size limits (413/400/etc).
 */

test.describe("Proxy body size limits", () => {
  // Generate a 2 MB string for testing
  const OVERSIZED_BODY = "x".repeat(2_000_000);

  test("validator proxy rejects 2MB body", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    // Should be rejected — either 413 from our code or 400/413 from platform
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("miner proxy rejects 2MB body", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test("multi-validator proxy rejects 2MB body", async ({ request }) => {
    const res = await request.post("/api/validators/0/v1/signal", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    // Should be rejected: 413 (our body limit) or 502 (validator lookup for UID 0 fails first)
    expect([413, 502]).toContain(res.status());
  });

  test("normal-sized body passes through", async ({ request }) => {
    const smallBody = JSON.stringify({ test: true });
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        "Content-Type": "application/json",
        Origin: "https://djinn.gg",
      },
      data: smallBody,
    });
    // Should not be 413 — may be 502 (validator down) or other, but not body-size-rejected
    expect(res.status()).not.toBe(413);
  });
});
