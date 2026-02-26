import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest } from "@/lib/admin-auth";

/**
 * GET /api/admin/feedback?limit=50&state=open
 *
 * Fetches user feedback from the GitHub issues repo.
 * Protected by admin session cookie.
 */

const GITHUB_REPO = process.env.ERROR_REPORT_REPO || "djinn-inc/error-reports";
const GITHUB_TOKEN = process.env.GITHUB_ERROR_TOKEN || "";

export async function GET(request: NextRequest) {
  if (!verifyAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!GITHUB_TOKEN) {
    return NextResponse.json({ feedback: [], total: 0, error: "GITHUB_ERROR_TOKEN not configured" });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
  const state = searchParams.get("state") || "all";

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues?labels=user-report&state=${state}&per_page=${limit}&sort=created&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return NextResponse.json(
        { feedback: [], total: 0, error: `GitHub API ${res.status}: ${err.slice(0, 200)}` },
      );
    }

    const issues = await res.json();

    const feedback = (issues as GitHubIssue[]).map((issue) => ({
      id: issue.number,
      title: issue.title,
      body: issue.body || "",
      state: issue.state,
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      html_url: issue.html_url,
      ...parseIssueBody(issue.body || ""),
    }));

    return NextResponse.json({ feedback, total: feedback.length });
  } catch (err) {
    return NextResponse.json(
      { feedback: [], total: 0, error: String(err) },
    );
  }
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
}

/** Extract structured fields from the issue body markdown. */
function parseIssueBody(body: string): {
  message?: string;
  source?: string;
  page?: string;
  wallet?: string;
  errorMessage?: string;
  userAgent?: string;
} {
  const get = (label: string): string | undefined => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
    const m = body.match(re);
    return m?.[1]?.trim() || undefined;
  };

  const errorBlock = body.match(/### Error\n```\n([\s\S]*?)```/);

  return {
    message: get("Message"),
    source: get("Source"),
    page: get("Page"),
    wallet: get("Wallet")?.replace(/`/g, ""),
    errorMessage: errorBlock?.[1]?.trim(),
    userAgent: undefined, // too noisy to show
  };
}
