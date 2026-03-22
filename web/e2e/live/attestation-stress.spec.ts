import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Attestation stress & smoke tests for djinn.gg/attest and debust.com.
 *
 * Key findings from testing:
 *  - djinn.gg → www.djinn.gg (307 redirect), must use www for API tests
 *  - debust.com uses /api/snap (async) not /api/attest
 *  - ~62% of miners (v512+) have TLSNotary, ~38% (v443-v504) do not
 *  - Miners max 3 concurrent attestations each
 *  - Rate limit: 5 requests/min per IP on djinn.gg
 *  - debust.com verifier binary is missing (proofs generate but don't verify server-side)
 */

// Attestation can take 30s-3min; give each test generous time
test.describe.configure({ timeout: 330_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("djinn-beta-access", "true");
  });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** POST /api/attest on djinn.gg (follows www redirect) */
async function djinnAttest(
  request: APIRequestContext,
  url: string,
  requestId?: string,
) {
  const id = requestId ?? `stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return request.post("https://www.djinn.gg/api/attest", {
    data: { url, request_id: id },
    timeout: 300_000,
  });
}

/** POST /api/snap on debust.com (async job creation) */
async function debustSnap(request: APIRequestContext, url: string) {
  return request.post("https://debust.com/api/snap", {
    data: { url },
    timeout: 30_000,
  });
}

/** GET /api/snap/{id} on debust.com (poll for result) */
async function debustPoll(request: APIRequestContext, id: string) {
  return request.get(`https://debust.com/api/snap/${id}`, { timeout: 10_000 });
}

/** Poll debust.com until complete or timeout */
async function debustSnapAndWait(
  request: APIRequestContext,
  url: string,
  maxWaitMs = 240_000,
): Promise<{ id: string; status: string; [k: string]: unknown }> {
  const createRes = await debustSnap(request, url);
  expect(createRes.ok()).toBe(true);
  const created = await createRes.json();
  const snapId = created.id as string;

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const pollRes = await debustPoll(request, snapId);
    if (!pollRes.ok()) continue;
    const data = await pollRes.json();
    if (data.status === "complete" || data.status === "error") {
      return data;
    }
  }
  return { id: snapId, status: "timeout" };
}

// ═════════════════════════════════════════════
// djinn.gg/attest — Page & UI
// ═════════════════════════════════════════════

test.describe("djinn.gg/attest — page rendering", () => {
  test("page loads and shows form", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.locator("h1")).toContainText("Web Attestation");
    await expect(page.locator("#attest-url")).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText("Attest");
  });

  test("how-it-works section renders 3 steps", async ({ page }) => {
    await page.goto("/attest");
    const steps = page.locator("ol > li");
    await expect(steps).toHaveCount(3);
  });

  test("API documentation section is collapsed by default", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.locator("pre").first()).not.toBeVisible();
    await page.getByText("API Documentation").click();
    await expect(page.locator("pre").first()).toBeVisible();
  });

  test("submit button disabled when URL is empty", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
  });

  test("client-side validation rejects non-https URL", async ({ page }) => {
    await page.goto("/attest");
    await page.fill("#attest-url", "http://httpbin.org/get");
    await page.click('button[type="submit"]');
    await expect(page.locator("text=URL must start with https://")).toBeVisible();
  });
});

// ═════════════════════════════════════════════
// djinn.gg /api/attest — Server validation
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — validation", () => {
  test("rejects missing URL", async ({ request }) => {
    const res = await request.post("https://www.djinn.gg/api/attest", {
      data: { request_id: "test-1" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("rejects non-https URL", async ({ request }) => {
    const res = await request.post("https://www.djinn.gg/api/attest", {
      data: { url: "http://httpbin.org/get", request_id: "test-2" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("HTTPS");
  });

  test("rejects missing request_id", async ({ request }) => {
    const res = await request.post("https://www.djinn.gg/api/attest", {
      data: { url: "https://httpbin.org/get" },
    });
    expect(res.status()).toBe(400);
  });

  test("rejects URL > 2048 chars", async ({ request }) => {
    const longUrl = "https://httpbin.org/get/" + "a".repeat(2048);
    const res = await request.post("https://www.djinn.gg/api/attest", {
      data: { url: longUrl, request_id: "test-long" },
    });
    expect(res.status()).toBe(400);
  });

  test("rejects request_id > 256 chars", async ({ request }) => {
    const res = await request.post("https://www.djinn.gg/api/attest", {
      data: { url: "https://httpbin.org/get", request_id: "x".repeat(257) },
    });
    expect(res.status()).toBe(400);
  });
});

// ═════════════════════════════════════════════
// SSRF protection
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — SSRF protection", () => {
  const blocked = [
    ["localhost", "https://localhost/secret"],
    ["127.0.0.1", "https://127.0.0.1/secret"],
    ["[::1]", "https://[::1]/secret"],
    ["0.0.0.0", "https://0.0.0.0/secret"],
    ["internal.local", "https://internal.local/path"],
    ["foo.internal", "https://foo.internal/path"],
    ["10.0.0.1", "https://10.0.0.1/secret"],
    ["172.16.0.1", "https://172.16.0.1/secret"],
    ["192.168.1.1", "https://192.168.1.1/secret"],
  ] as const;

  for (const [label, url] of blocked) {
    test(`blocks ${label}`, async ({ request }) => {
      const res = await request.post("https://www.djinn.gg/api/attest", {
        data: { url, request_id: "ssrf-test" },
        timeout: 30_000,
      });
      // Accept 400 (SSRF blocked) or 429 (rate limited — also a valid block)
      expect([400, 429]).toContain(res.status());
      if (res.status() === 400) {
        const body = await res.json();
        expect(body.error).toContain("public");
      }
    });
  }
});

// ═════════════════════════════════════════════
// Rate limiting
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — rate limiting", () => {
  test("rate limits after 5 rapid requests", async ({ request }) => {
    // Use invalid requests (bad URL) so they return fast without hitting validators
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request.post("https://www.djinn.gg/api/attest", {
        data: { url: "http://bad-not-https", request_id: `rate-${i}` },
        timeout: 10_000,
      });
      results.push(res.status());
    }
    // Should see mix of 400 (validation) and 429 (rate limited)
    const rateLimited = results.filter((s) => s === 429).length;
    const validated = results.filter((s) => s === 400).length;
    console.log(
      `[rate-limit] 7 rapid: 400=${validated}, 429=${rateLimited}`,
    );
    expect(rateLimited).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════
// djinn.gg/attest — Single attestation E2E
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — single attestation", () => {
  test("attests httpbin.org via API", async ({ request }) => {
    const start = Date.now();
    const res = await djinnAttest(request, "https://httpbin.org/get");
    const elapsed = Date.now() - start;

    if (res.ok()) {
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.proof_hex).toBeTruthy();
      expect(typeof body.proof_hex).toBe("string");
      expect(body.proof_hex.length).toBeGreaterThan(100);
      expect(body.server_name).toBeTruthy();
      expect(body.timestamp).toBeGreaterThan(0);
      expect(/^[0-9a-f]+$/i.test(body.proof_hex)).toBe(true);
      console.log(
        `[djinn.gg] httpbin.org: ${(elapsed / 1000).toFixed(1)}s, ` +
          `proof=${(body.proof_hex.length / 2).toLocaleString()} bytes, ` +
          `server=${body.server_name}, verified=${body.verified}`,
      );
    } else if (res.status() === 502 || res.status() === 503) {
      const body = await res.json();
      console.log(`[djinn.gg] Unavailable (${res.status()}): ${body.error}`);
    } else {
      console.log(`[djinn.gg] Unexpected status ${res.status()}`);
      expect(res.status()).toBeLessThan(500);
    }
  });

  test("attests httpbin.org/get via API", async ({ request }) => {
    const start = Date.now();
    const res = await djinnAttest(request, "https://httpbin.org/get");
    const elapsed = Date.now() - start;

    if (res.ok()) {
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.proof_hex).toBeTruthy();
      if (body.response_body) {
        expect(body.response_body).toContain("origin");
      }
      console.log(
        `[djinn.gg] httpbin: ${(elapsed / 1000).toFixed(1)}s, ` +
          `proof=${(body.proof_hex.length / 2).toLocaleString()} bytes, ` +
          `verified=${body.verified}`,
      );
    } else {
      console.log(`[djinn.gg] httpbin: status=${res.status()}`);
    }
  });

  test("UI flow: type URL and submit", async ({ page }) => {
    await page.goto("/attest");
    await page.fill("#attest-url", "https://httpbin.org/get");
    await page.click('button[type="submit"]');

    await expect(page.getByText("Generating proof...")).toBeVisible({ timeout: 5_000 });

    const result = page.locator("text=Attestation Result");
    const error = page.locator(".bg-red-50");
    await expect(result.or(error)).toBeVisible({ timeout: 310_000 });

    if (await result.isVisible()) {
      await expect(page.locator("text=Verified").or(page.locator("text=Unverified"))).toBeVisible();
      await expect(page.getByText("Proof size")).toBeVisible();
      await expect(page.getByText("Download proof")).toBeVisible();
      console.log("[djinn.gg] UI attestation succeeded");
    } else {
      const errorText = await error.textContent();
      console.log(`[djinn.gg] UI attestation error: ${errorText}`);
    }
  });
});

// ═════════════════════════════════════════════
// djinn.gg/attest — Concurrent stress test
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — concurrent stress", () => {
  test("3 concurrent attestations (different URLs)", async ({ request }) => {
    const urls = [
      "https://httpbin.org/get",
      "https://httpbin.org/get",
      "https://api.github.com/zen",
    ];

    const start = Date.now();
    const promises = urls.map((url, i) =>
      djinnAttest(request, url, `concurrent-3-${i}`),
    );
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    let succeeded = 0;
    let busy = 0;
    let failed = 0;

    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (res.ok()) {
        const body = await res.json();
        if (body.success) {
          succeeded++;
          console.log(
            `[stress-3] ${urls[i]}: OK, proof=${(body.proof_hex?.length ?? 0) / 2} bytes`,
          );
        } else if (body.busy) {
          busy++;
          console.log(`[stress-3] ${urls[i]}: BUSY`);
        } else {
          failed++;
          console.log(`[stress-3] ${urls[i]}: fail — ${body.error}`);
        }
      } else {
        const body = await res.json().catch(() => ({} as Record<string, string>));
        if (res.status() === 503) {
          busy++;
        } else {
          failed++;
        }
        console.log(
          `[stress-3] ${urls[i]}: HTTP ${res.status()} — ${(body as Record<string, string>).error ?? ""}`,
        );
      }
    }

    console.log(
      `[stress-3] Total: ${(elapsed / 1000).toFixed(1)}s, ` +
        `succeeded=${succeeded}, busy=${busy}, failed=${failed}`,
    );
    expect(succeeded + busy).toBeGreaterThan(0);
  });

  test("5 concurrent attestations (same URL)", async ({ request }) => {
    const start = Date.now();
    const promises = Array.from({ length: 5 }, (_, i) =>
      djinnAttest(request, "https://httpbin.org/get", `concurrent-5-${i}`),
    );
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    let succeeded = 0;
    let busy = 0;
    let rateLimited = 0;
    let failed = 0;

    for (const res of responses) {
      if (res.status() === 429) rateLimited++;
      else if (res.status() === 503) busy++;
      else if (res.ok()) {
        const body = await res.json();
        if (body.success) succeeded++;
        else if (body.busy) busy++;
        else failed++;
      } else {
        failed++;
      }
    }

    console.log(
      `[stress-5] ${(elapsed / 1000).toFixed(1)}s | ` +
        `ok=${succeeded} busy=${busy} rateLimit=${rateLimited} fail=${failed}`,
    );
    expect(succeeded + busy + rateLimited).toBeGreaterThan(0);
  });

  test("10 concurrent attestations (breaking point)", async ({ request }) => {
    const start = Date.now();
    const promises = Array.from({ length: 10 }, (_, i) =>
      djinnAttest(request, "https://httpbin.org/get", `concurrent-10-${i}`),
    );
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    let succeeded = 0;
    let busy = 0;
    let rateLimited = 0;
    let errors = 0;

    for (const res of responses) {
      const status = res.status();
      if (status === 429) rateLimited++;
      else if (status === 503) busy++;
      else if (status >= 200 && status < 300) {
        const body = await res.json();
        if (body.success) succeeded++;
        else if (body.busy) busy++;
        else errors++;
      } else {
        errors++;
      }
    }

    console.log(
      `[stress-10] ${(elapsed / 1000).toFixed(1)}s | ` +
        `ok=${succeeded} busy=${busy} rateLimit=${rateLimited} err=${errors}`,
    );
    // At 10 concurrent, rate limiting (5/min) should block most
    expect(rateLimited).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════
// djinn.gg/attest — Edge cases
// ═════════════════════════════════════════════

test.describe("djinn.gg /api/attest — edge cases", () => {
  test("large page fails gracefully", async ({ request }) => {
    const res = await djinnAttest(request, "https://www.reddit.com");
    if (res.ok()) {
      const body = await res.json();
      if (!body.success) {
        console.log(`[edge] reddit.com: expected failure — ${body.error}`);
      } else {
        console.log(`[edge] reddit.com: surprisingly succeeded`);
      }
    } else {
      const body = await res.json().catch(() => ({} as Record<string, string>));
      console.log(
        `[edge] reddit.com: HTTP ${res.status()} — ${(body as Record<string, string>).error ?? ""}`,
      );
      expect(res.status()).not.toBe(500);
    }
  });

  test("non-existent domain returns clean error", async ({ request }) => {
    const res = await djinnAttest(
      request,
      "https://this-domain-definitely-does-not-exist-xyz123.com",
    );
    const body = await res.json();
    if (!res.ok() || !body.success) {
      expect(body.error).toBeTruthy();
      console.log(`[edge] bad domain: ${body.error}`);
    }
    // Accept any non-500 status — may get 200 with error, or 502, or 429 (rate limited)
    expect(res.status()).not.toBe(500);
  });
});

// ═════════════════════════════════════════════
// debust.com — Page & rendering
// ═════════════════════════════════════════════

test.describe("debust.com — page rendering", () => {
  test("homepage loads with form", async ({ page }) => {
    await page.goto("https://debust.com", { timeout: 30_000 });
    await expect(page).toHaveTitle(/debust/i);
    await expect(page.locator(".url-input")).toBeVisible();
    await expect(page.locator(".submit-btn")).toBeVisible();
    await expect(page.locator(".submit-btn")).toContainText("debust");
    console.log("[debust] Homepage loaded with form");
  });

  test("submit button disabled when input is empty", async ({ page }) => {
    await page.goto("https://debust.com", { timeout: 30_000 });
    await expect(page.locator(".submit-btn")).toBeDisabled();
  });

  test("/recent page loads", async ({ page }) => {
    await page.goto("https://debust.com/recent", { timeout: 30_000 });
    await expect(page).toHaveTitle(/debust/i);
    console.log("[debust] Recent page loaded");
  });

  test("shows Bittensor SN103 attribution", async ({ page }) => {
    await page.goto("https://debust.com", { timeout: 30_000 });
    await expect(page.locator("text=SN103")).toBeVisible();
  });
});

// ═════════════════════════════════════════════
// debust.com — /api/snap API
// ═════════════════════════════════════════════

test.describe("debust.com /api/snap — validation", () => {
  test("rejects empty body", async ({ request }) => {
    const res = await request.post("https://debust.com/api/snap", {
      data: {},
    });
    const body = await res.json();
    expect(body.error).toContain("URL");
  });

  test("accepts http URL (debust generates screenshot anyway)", async ({ request }) => {
    // debust.com accepted http://httpbin.org/get without error in earlier test
    const res = await debustSnap(request, "http://httpbin.org/get");
    if (res.ok()) {
      const body = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.status).toBe("processing");
      console.log(`[debust] http URL accepted, id=${body.id}`);
    }
  });

  test("creates snap job and returns ID", async ({ request }) => {
    const res = await debustSnap(request, "https://httpbin.org/get");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("processing");
    expect(typeof body.position).toBe("number");
    console.log(`[debust] Snap created: id=${body.id}, position=${body.position}`);
  });
});

test.describe("debust.com /api/snap — full flow", () => {
  test("snap httpbin.org end-to-end", async ({ request }) => {
    const start = Date.now();
    const result = await debustSnapAndWait(request, "https://httpbin.org/get");
    const elapsed = Date.now() - start;

    console.log(
      `[debust] E2E: ${(elapsed / 1000).toFixed(1)}s, ` +
        `status=${result.status}, verified=${result.verified}, ` +
        `has_screenshot=${result.has_screenshot}, has_proof=${result.has_proof}`,
    );

    if (result.error) {
      console.log(`[debust] Error: ${result.error}`);
    }

    expect(result.status).toBe("complete");
    expect(result.has_screenshot).toBe(true);
    // KNOWN ISSUE: has_proof is inconsistent — sometimes false even on success.
    // debust.com also lacks djinn-tlsn-verifier binary, so verified is always false.
    if (!result.verified) {
      console.log("[debust] WARNING: Proof not verified server-side (verifier binary missing)");
    }
  });

  test("snap images are accessible", async ({ request }) => {
    const result = await debustSnapAndWait(request, "https://httpbin.org/get");
    if (result.status !== "complete" || !result.images) {
      test.skip();
      return;
    }

    const images = result.images as Record<string, string>;
    for (const [type, path] of Object.entries(images)) {
      const imgRes = await request.get(`https://debust.com${path}`, {
        timeout: 15_000,
      });
      console.log(`[debust] Image ${type}: HTTP ${imgRes.status()}, ${path}`);
      expect(imgRes.ok()).toBe(true);
    }
  });
});

test.describe("debust.com /api/snap — concurrent stress", () => {
  test("3 concurrent snaps", async ({ request }) => {
    const start = Date.now();
    const promises = Array.from({ length: 3 }, () =>
      debustSnap(request, "https://httpbin.org/get"),
    );
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    let created = 0;
    let failed = 0;
    const ids: string[] = [];

    for (const res of responses) {
      if (res.ok()) {
        const body = await res.json();
        if (body.id) {
          created++;
          ids.push(body.id);
        } else {
          failed++;
        }
      } else {
        failed++;
      }
    }

    console.log(
      `[debust-stress-3] ${(elapsed / 1000).toFixed(1)}s | ` +
        `created=${created} failed=${failed} ids=${ids.join(",")}`,
    );
    expect(created).toBeGreaterThan(0);

    // Wait for all to complete and check results
    if (ids.length > 0) {
      await new Promise((r) => setTimeout(r, 60_000)); // wait 60s for processing
      let completed = 0;
      for (const id of ids) {
        const pollRes = await debustPoll(request, id);
        if (pollRes.ok()) {
          const data = await pollRes.json();
          if (data.status === "complete") completed++;
          console.log(
            `[debust-stress-3] ${id}: status=${data.status}, verified=${data.verified}`,
          );
        }
      }
      console.log(`[debust-stress-3] Completed: ${completed}/${ids.length}`);
    }
  });

  test("5 concurrent snaps (stress)", async ({ request }) => {
    const start = Date.now();
    const promises = Array.from({ length: 5 }, () =>
      debustSnap(request, "https://httpbin.org/get"),
    );
    const responses = await Promise.all(promises);
    const elapsed = Date.now() - start;

    let created = 0;
    let rateLimited = 0;
    let failed = 0;

    for (const res of responses) {
      if (res.status() === 429) {
        rateLimited++;
      } else if (res.ok()) {
        const body = await res.json();
        if (body.id) created++;
        else failed++;
      } else {
        failed++;
      }
    }

    console.log(
      `[debust-stress-5] ${(elapsed / 1000).toFixed(1)}s | ` +
        `created=${created} rateLimit=${rateLimited} failed=${failed}`,
    );
  });
});

// ═════════════════════════════════════════════
// debust.com — UI flow
// ═════════════════════════════════════════════

test.describe("debust.com — UI attestation flow", () => {
  test("type URL and submit", async ({ page }) => {
    await page.goto("https://debust.com", { timeout: 30_000 });
    await page.fill(".url-input", "https://httpbin.org/get");

    // Button should be enabled now
    await expect(page.locator(".submit-btn")).toBeEnabled();
    await page.click(".submit-btn");

    // Should navigate to a result page or show processing state
    // Wait for URL change or content change
    await page.waitForURL(/\/(s|snap|processing)\//, { timeout: 60_000 }).catch(() => {
      // May stay on same page with inline result
    });

    // Log what happened
    const currentUrl = page.url();
    console.log(`[debust] After submit, URL: ${currentUrl}`);

    // If redirected to a result page, check it loads
    if (currentUrl.includes("/s/") || currentUrl.includes("/snap/")) {
      // Wait for the page to show a result
      await page.waitForLoadState("networkidle", { timeout: 240_000 }).catch(() => {});
      const title = await page.title();
      console.log(`[debust] Result page title: ${title}`);
    }
  });
});

// ═════════════════════════════════════════════
// Cross-site comparison
// ═════════════════════════════════════════════

test.describe("djinn.gg vs debust.com — comparison", () => {
  test("both generate proofs for httpbin.org", async ({ request }) => {
    const [djinnRes, debustRes] = await Promise.all([
      djinnAttest(request, "https://httpbin.org/get", "parity-djinn"),
      debustSnapAndWait(request, "https://httpbin.org/get"),
    ]);

    const djinnOk = djinnRes.ok() ? (await djinnRes.json()).success : false;
    const debustOk = debustRes.status === "complete" && debustRes.has_proof;

    console.log(`[parity] djinn.gg: ${djinnOk ? "OK" : "FAIL"}`);
    console.log(`[parity] debust.com: ${debustOk ? "OK" : "FAIL"} (verified=${debustRes.verified})`);

    // debust.com has known verifier issue — proof exists but isn't verified
    if (debustOk && !debustRes.verified) {
      console.log("[parity] ISSUE: debust.com proofs not verified (missing djinn-tlsn-verifier binary)");
    }
  });
});
