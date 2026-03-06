// Validate contract addresses at build time in production (warn only — fatal when STRICT_ENV_CHECK=1)
if (process.env.NODE_ENV === "production") {
  const addressPattern = /^0x[0-9a-fA-F]{40}$/;
  const required = [
    "NEXT_PUBLIC_USDC_ADDRESS",
    "NEXT_PUBLIC_ESCROW_ADDRESS",
    "NEXT_PUBLIC_SIGNAL_COMMITMENT_ADDRESS",
    "NEXT_PUBLIC_COLLATERAL_ADDRESS",
    "NEXT_PUBLIC_CREDIT_LEDGER_ADDRESS",
    "NEXT_PUBLIC_ACCOUNT_ADDRESS",
  ];
  const strict = process.env.STRICT_ENV_CHECK === "1";
  for (const key of required) {
    const val = process.env[key];
    if (!val || !addressPattern.test(val)) {
      const msg = `${key} is missing or invalid (expected 0x-prefixed 40-hex address, got: ${val || "undefined"})`;
      if (strict) {
        throw new Error(msg);
      }
      console.warn(`[Djinn] WARNING: ${msg}`);
    }
  }
}

// Embed git commit count + short hash at build time for admin version display
const { execSync } = require("child_process");
let gitVersion = "dev";
try {
  const count = execSync("git rev-list --count HEAD", { encoding: "utf8" }).trim();
  const hash = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  gitVersion = `${count} (${hash})`;
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_GIT_VERSION: gitVersion,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        // CSP is set by middleware.ts — only keep non-CSP security headers here as fallback for static assets
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
