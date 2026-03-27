import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// OFAC-sanctioned country codes (ISO 3166-1 alpha-2)
// Cuba, Iran, North Korea, Syria, Crimea/Donetsk/Luhansk (treated as separate by some providers)
const SANCTIONED_COUNTRIES = new Set([
  "CU", // Cuba
  "IR", // Iran
  "KP", // North Korea
  "SY", // Syria
  "SD", // Sudan
  "MM", // Myanmar (limited sanctions)
]);

// Paths that are always accessible (legal pages, static assets, health checks)
const EXEMPT_PATHS = [
  "/terms",
  "/privacy",
  "/about",
  "/blocked",
  "/api/health",
  "/_next",
  "/favicon.ico",
  "/manifest.json",
  "/robots.txt",
  "/sitemap.xml",
];

// Rate limiting state (in-memory, per-instance)
// Vercel serverless: each instance has its own map, so this is approximate
// but sufficient for per-request burst protection
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 200; // 200 requests per minute per IP

function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATHS.some((p) => pathname.startsWith(p));
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// Periodically clean up stale rate limit entries (every ~100 requests)
let cleanupCounter = 0;
function maybeCleanup() {
  cleanupCounter += 1;
  if (cleanupCounter % 100 !== 0) return;
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key);
    }
  }
}

const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.base.org wss://*.base.org https://api.the-odds-api.com https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://api.studio.thegraph.com https://api.web3modal.org https://*.web3modal.org",
  "frame-src https://challenges.cloudflare.com",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Content-Security-Policy": cspDirectives,
};

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Skip geo-blocking and rate limiting for exempt paths
  if (!isExemptPath(pathname)) {
    // Geo-blocking: Vercel provides country code via header
    const country =
      request.headers.get("x-vercel-ip-country") ||
      request.geo?.country ||
      "";

    if (country && SANCTIONED_COUNTRIES.has(country.toUpperCase())) {
      // Redirect to blocked page for page requests, return 451 for API requests
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          {
            error: "unavailable_region",
            message:
              "Djinn is not available in your region due to regulatory restrictions.",
          },
          { status: 451 },
        );
      }
      return NextResponse.redirect(new URL("/blocked", request.url));
    }

    // Rate limiting
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";

    // Skip rate limiting for localhost (dev/testing)
    const isLocalhost = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLocalhost) {

      if (ip !== "unknown") {
        maybeCleanup();
        const { allowed, remaining } = checkRateLimit(ip);
        if (!allowed) {
          const retryAfter = Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
          if (pathname.startsWith("/api/")) {
            return NextResponse.json(
              {
                error: "rate_limit_exceeded",
                message: `Too many requests. Limit: ${RATE_LIMIT_MAX} per minute. Try again in ${retryAfter} seconds.`,
                retry_after: retryAfter,
              },
              {
                status: 429,
                headers: {
                  "Retry-After": String(retryAfter),
                  "X-RateLimit-Limit": String(RATE_LIMIT_MAX),
                  "X-RateLimit-Remaining": "0",
                },
              },
            );
          }
          // For page requests, return a simple 429
          return new NextResponse("Too many requests. Please try again shortly.", {
            status: 429,
            headers: { "Retry-After": String(retryAfter) },
          });
        }
      }
    } // end if (!isLocalhost)
  }

  const response = NextResponse.next();

  // Security headers
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  // CORS for API routes
  if (pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin") ?? "";
    const allowedOrigins = [
      process.env.NEXT_PUBLIC_APP_URL || "https://djinn.gg",
      ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
    ];

    if (allowedOrigins.includes(origin)) {
      response.headers.set("Access-Control-Allow-Origin", origin);
    }

    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    response.headers.set("Access-Control-Max-Age", "86400");

    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: response.headers });
    }
  }

  return response;
}

export const config = {
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
