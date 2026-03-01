import { NextRequest, NextResponse } from "next/server";
import { storeError } from "@/lib/error-store";

/**
 * POST /api/report-error
 *
 * Accepts error reports from the web client. Two actions:
 * 1. Stores in an in-memory ring buffer for admin dashboard viewing
 * 2. Creates a GitHub issue in a private repo (if GITHUB_ERROR_TOKEN is set)
 *
 * No authentication required — users don't need a GitHub account.
 * Rate-limited to prevent abuse.
 */

const MAX_BODY_SIZE = 10_000; // 10KB max
const GITHUB_REPO = process.env.ERROR_REPORT_REPO || "djinn-inc/error-reports";
const GITHUB_TOKEN = process.env.GITHUB_ERROR_TOKEN || "";

// Simple in-memory rate limiter: max 5 reports per IP per 10 minutes
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000; // 10 min
const RATE_LIMIT_MAX = 5;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  // Evict old entries
  if (rateLimitMap.size > 1000) {
    for (const [key, ts] of rateLimitMap) {
      if (ts.every((t) => now - t > RATE_LIMIT_WINDOW)) rateLimitMap.delete(key);
    }
  }
  return false;
}

function getIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

interface ErrorReport {
  // Required
  message: string;
  // Optional context
  url?: string;
  errorMessage?: string;
  errorStack?: string;
  userAgent?: string;
  wallet?: string; // first 6 + last 4 chars only
  signalId?: string;
  consoleErrors?: string[];
  timestamp?: string;
  source?: "error-boundary" | "report-button" | "api-error" | "other";
}

export async function POST(request: NextRequest) {
  const ip = getIp(request);
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many error reports. Please try again later." },
      { status: 429 },
    );
  }

  let body: ErrorReport;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Report too large" },
        { status: 413 },
      );
    }
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (!body.message || typeof body.message !== "string" || body.message.length > 2000) {
    return NextResponse.json(
      { error: "message is required (max 2000 chars)" },
      { status: 400 },
    );
  }

  // Sanitize: truncate fields
  const report = {
    message: body.message.slice(0, 2000),
    url: (body.url || "").slice(0, 500),
    errorMessage: (body.errorMessage || "").slice(0, 1000),
    errorStack: (body.errorStack || "").slice(0, 2000),
    userAgent: (body.userAgent || "").slice(0, 300),
    wallet: (body.wallet || "").slice(0, 14), // already truncated client-side
    signalId: (body.signalId || "").slice(0, 100),
    consoleErrors: (body.consoleErrors || []).slice(0, 5).map((e) => String(e).slice(0, 500)),
    source: body.source || "other",
    timestamp: new Date().toISOString(),
    ip: ip.slice(0, 45), // truncated for privacy
  };

  // 1. Store in memory for admin dashboard
  storeError(report);

  // 2. Create GitHub issue (non-blocking)
  if (GITHUB_TOKEN) {
    createGitHubIssue(report).catch((err) => {
      console.error("[report-error] Failed to create GitHub issue:", err);
    });
  }

  return NextResponse.json({ ok: true });
}

async function createGitHubIssue(report: typeof Object.prototype & Record<string, unknown>) {
  const r = report as Record<string, unknown>;
  const title = `[User Report] ${(r.message as string).slice(0, 80)}`;
  const body = [
    `## Error Report`,
    ``,
    `**Message:** ${r.message}`,
    `**Source:** ${r.source}`,
    `**Page:** ${r.url || "N/A"}`,
    `**Time:** ${r.timestamp}`,
    r.wallet ? `**Wallet:** \`${r.wallet}\`` : "",
    r.signalId ? `**Signal:** \`${r.signalId}\`` : "",
    ``,
    r.errorMessage ? `### Error\n\`\`\`\n${r.errorMessage}\n\`\`\`` : "",
    r.errorStack ? `### Stack Trace\n\`\`\`\n${r.errorStack}\n\`\`\`` : "",
    (r.consoleErrors as string[])?.length
      ? `### Recent Console Errors\n\`\`\`\n${(r.consoleErrors as string[]).join("\n")}\n\`\`\``
      : "",
    ``,
    `### Environment`,
    `\`\`\``,
    `User-Agent: ${r.userAgent || "N/A"}`,
    `\`\`\``,
    ``,
    `---`,
    `*Submitted via djinn.gg error reporter*`,
  ]
    .filter(Boolean)
    .join("\n");

  const labels = ["user-report"];
  if (r.source === "error-boundary") labels.push("crash");

  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(10_000),
  });
}
