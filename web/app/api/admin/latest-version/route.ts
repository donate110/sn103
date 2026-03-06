import { NextResponse } from "next/server";

const REPO = "Djinn-Inc/djinn";
const BRANCH = "main";
const CACHE_TTL_MS = 60_000; // 1 minute

let cached: { version: number; sha: string; ts: number } | null = null;

export async function GET() {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached);
  }

  try {
    // GitHub returns a Link header with the last page number when per_page=1,
    // which equals the total commit count on the branch.
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=1`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        next: { revalidate: 60 },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub API ${res.status}` },
        { status: 502 }
      );
    }

    const link = res.headers.get("link") || "";
    // Parse: <...?page=537>; rel="last"
    const lastMatch = link.match(/[&?]page=(\d+)[^>]*>;\s*rel="last"/);
    const version = lastMatch ? parseInt(lastMatch[1], 10) : 0;

    const commits = await res.json();
    const sha = commits[0]?.sha?.slice(0, 7) || "";

    cached = { version, sha, ts: Date.now() };
    return NextResponse.json(cached);
  } catch (e) {
    return NextResponse.json(
      { error: String(e) },
      { status: 502 }
    );
  }
}
