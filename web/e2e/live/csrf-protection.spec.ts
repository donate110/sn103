import { test, expect } from "@playwright/test";

/**
 * CSRF protection tests.
 *
 * Verifies that proxy routes reject cross-origin POST requests
 * from unauthorized origins.
 */

test.describe("CSRF — validator proxy", () => {
  test("POST with evil origin is rejected", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/json",
      },
      data: { test: true },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  test("POST with evil.vercel.app origin is rejected", async ({
    request,
  }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        Origin: "https://evil.vercel.app",
        "Content-Type": "application/json",
      },
      data: { test: true },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  test("POST with attacker-djinn.vercel.app origin is rejected", async ({
    request,
  }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        Origin: "https://attacker-djinn.vercel.app",
        "Content-Type": "application/json",
      },
      data: { test: true },
    });
    // Should be rejected — doesn't end with .djinn.vercel.app
    expect(res.status()).toBe(403);
  });

  test("POST with legitimate origin is allowed", async ({ request }) => {
    const res = await request.post("/api/validator/v1/signal", {
      headers: {
        Origin: "https://djinn.gg",
        "Content-Type": "application/json",
      },
      data: {},
    });
    // Should not be 403 (may be 502 if validator is down, or 400 for bad body, but not CSRF-rejected)
    expect(res.status()).not.toBe(403);
  });

  test("GET requests pass without origin check", async ({ request }) => {
    const res = await request.get("/api/validator/health");
    expect(res.ok()).toBeTruthy();
  });
});

test.describe("CSRF — miner proxy", () => {
  test("POST with evil origin is rejected", async ({ request }) => {
    const res = await request.post("/api/miner/v1/check", {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/json",
      },
      data: { lines: [] },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  test("POST with evil.vercel.app origin is rejected", async ({
    request,
  }) => {
    const res = await request.post("/api/miner/v1/check", {
      headers: {
        Origin: "https://phishing.vercel.app",
        "Content-Type": "application/json",
      },
      data: { lines: [] },
    });
    expect(res.status()).toBe(403);
  });
});

test.describe("CSRF — multi-validator proxy", () => {
  test("POST with evil origin is rejected", async ({ request }) => {
    const res = await request.post("/api/validators/0/v1/signal", {
      headers: {
        Origin: "https://evil.com",
        "Content-Type": "application/json",
      },
      data: { test: true },
    });
    expect(res.status()).toBe(403);
  });
});
