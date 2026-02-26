import { test, expect } from "@playwright/test";

/**
 * Proxy body size limit tests.
 *
 * Verifies that all proxy routes reject requests with bodies > 1 MB.
 */

test.describe("Proxy body size limits", () => {
  // Generate a 2 MB string for testing
  const OVERSIZED_BODY = "x".repeat(2_000_000);

  test("validator proxy rejects 2MB body with 413", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("too large");
  });

  test("miner proxy rejects 2MB body with 413", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("too large");
  });

  test("multi-validator proxy rejects 2MB body with 413", async ({
    request,
  }) => {
    const res = await request.post("/api/validators/0/v1/signal", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(OVERSIZED_BODY.length),
        Origin: "https://djinn.gg",
      },
      data: OVERSIZED_BODY,
    });
    expect(res.status()).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("too large");
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
