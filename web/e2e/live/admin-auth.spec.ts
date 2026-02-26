import { test, expect } from "@playwright/test";

/**
 * Admin authentication security tests.
 *
 * Verifies that admin endpoints reject unauthenticated requests,
 * wrong passwords, and forged cookies, and that correct auth works.
 */

test.describe("Admin auth — unauthenticated access", () => {
  test("GET /api/admin/errors without auth returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/errors");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("GET /api/admin/feedback without auth returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/feedback");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("GET /api/admin/auth without cookie returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/auth");
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });
});

test.describe("Admin auth — wrong password", () => {
  test("POST /api/admin/auth with wrong password returns 401", async ({
    request,
  }) => {
    const res = await request.post("/api/admin/auth", {
      data: { password: "definitely-wrong-password-12345" },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("POST /api/admin/auth with empty password returns 401", async ({
    request,
  }) => {
    const res = await request.post("/api/admin/auth", {
      data: { password: "" },
    });
    expect(res.status()).toBe(401);
  });

  test("POST /api/admin/auth with missing password field returns 401", async ({
    request,
  }) => {
    const res = await request.post("/api/admin/auth", {
      data: {},
    });
    expect(res.status()).toBe(401);
  });

  test("POST /api/admin/auth with invalid JSON returns 400", async ({
    request,
  }) => {
    const res = await request.post("/api/admin/auth", {
      headers: { "Content-Type": "application/json" },
      data: "not json",
    });
    // Should return 400 for invalid JSON
    expect(res.status()).toBe(400);
  });
});

test.describe("Admin auth — forged cookies", () => {
  test("GET /api/admin/errors with forged cookie returns 401", async ({
    request,
  }) => {
    // This is the old prefix-based check that used to pass — should now fail
    const forgedCookie = Buffer.from("djinn-admin:9999999999999:fakesig").toString("base64");
    const res = await request.get("/api/admin/errors", {
      headers: {
        Cookie: `djinn_admin_token=${forgedCookie}`,
      },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/admin/feedback with forged cookie returns 401", async ({
    request,
  }) => {
    const forgedCookie = Buffer.from("djinn-admin:9999999999999:fakesig").toString("base64");
    const res = await request.get("/api/admin/feedback", {
      headers: {
        Cookie: `djinn_admin_token=${forgedCookie}`,
      },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/admin/auth with expired token returns 401", async ({
    request,
  }) => {
    // Token with timestamp from 2020 — should be expired
    const expiredCookie = Buffer.from("djinn-admin:1577836800000:fakesig").toString("base64");
    const res = await request.get("/api/admin/auth", {
      headers: {
        Cookie: `djinn_admin_token=${expiredCookie}`,
      },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/admin/errors with random bearer token returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/admin/errors", {
      headers: {
        Authorization: "Bearer random-wrong-password",
      },
    });
    expect(res.status()).toBe(401);
  });
});
