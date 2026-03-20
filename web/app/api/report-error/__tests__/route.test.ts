import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock error-store
const mockStoreError = vi.fn();
vi.mock("@/lib/error-store", () => ({
  storeError: (...args: unknown[]) => mockStoreError(...args),
}));

import { POST } from "../route";

function makeRequest(body: Record<string, unknown>, ip = "1.2.3.4"): NextRequest {
  return new NextRequest("http://localhost:3000/api/report-error", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/report-error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid error report", async () => {
    const resp = await POST(
      makeRequest({
        message: "Something broke",
        url: "/genius",
        source: "report-button",
      }, "10.0.0.1"),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  it("rejects missing message", async () => {
    const resp = await POST(
      makeRequest({ url: "/genius" }, "10.0.0.2"),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects oversized message", async () => {
    const resp = await POST(
      makeRequest({ message: "x".repeat(2001) }, "10.0.0.3"),
    );
    expect(resp.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const req = new NextRequest("http://localhost:3000/api/report-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "10.0.0.4",
      },
      body: "not json",
    });
    const resp = await POST(req);
    expect(resp.status).toBe(400);
  });

  it("rate limits after 5 requests from same IP", async () => {
    const ip = "192.168.99.88";
    for (let i = 0; i < 5; i++) {
      const resp = await POST(
        makeRequest({ message: `report ${i}` }, ip),
      );
      expect(resp.status).toBe(200);
    }
    const resp = await POST(
      makeRequest({ message: "too many" }, ip),
    );
    expect(resp.status).toBe(429);
  });

  it("stores error in memory via storeError", async () => {
    await POST(
      makeRequest({ message: "logged error", source: "error-boundary" }, "10.0.0.5"),
    );
    expect(mockStoreError).toHaveBeenCalledTimes(1);
    const report = mockStoreError.mock.calls[0][0];
    expect(report.message).toBe("logged error");
    expect(report.source).toBe("error-boundary");
  });
});
