import { describe, it, expect } from "vitest";

// We can't import next.config.js directly (CommonJS), but we can
// verify the security headers are present by reading the config
const nextConfig = require("../../next.config.js");

describe("next.config.js", () => {
  it("exports a valid config object", () => {
    expect(nextConfig).toBeDefined();
    expect(typeof nextConfig.headers).toBe("function");
  });

  it("configures security headers", async () => {
    const headerEntries = await nextConfig.headers();
    expect(headerEntries.length).toBeGreaterThan(0);

    const globalHeaders = headerEntries[0];
    expect(globalHeaders.source).toBe("/(.*)");

    const headerNames = globalHeaders.headers.map(
      (h: { key: string }) => h.key
    );
    expect(headerNames).toContain("X-Frame-Options");
    expect(headerNames).toContain("X-Content-Type-Options");
    expect(headerNames).toContain("Referrer-Policy");
    expect(headerNames).toContain("Permissions-Policy");
    expect(headerNames).toContain("Strict-Transport-Security");
    // CSP is set by middleware.ts, not in next.config.js headers
  });

  it("denies framing", async () => {
    const headerEntries = await nextConfig.headers();
    const headers = headerEntries[0].headers;
    const xfo = headers.find((h: { key: string }) => h.key === "X-Frame-Options");
    expect(xfo.value).toBe("DENY");
  });

  it("enables HSTS with preload", async () => {
    const headerEntries = await nextConfig.headers();
    const headers = headerEntries[0].headers;
    const hsts = headers.find(
      (h: { key: string }) => h.key === "Strict-Transport-Security"
    );
    expect(hsts.value).toContain("max-age=");
    expect(hsts.value).toContain("preload");
  });

  it("denies framing via X-Frame-Options", async () => {
    // CSP frame-ancestors is set by middleware.ts; X-Frame-Options is the
    // next.config.js fallback for static assets.
    const headerEntries = await nextConfig.headers();
    const headers = headerEntries[0].headers;
    const xfo = headers.find(
      (h: { key: string }) => h.key === "X-Frame-Options"
    );
    expect(xfo.value).toBe("DENY");
  });

  it("does not configure webpack overrides", () => {
    // Webpack polyfills were removed with ZK/snarkjs dependencies
    expect(nextConfig.webpack).toBeUndefined();
  });
});
