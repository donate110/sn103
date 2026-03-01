/**
 * In-memory ring buffer for error reports.
 * Works on all runtimes (Vercel, Cloudflare, Deno).
 * Errors are ephemeral — lost on cold start, which is fine for debugging.
 */

const MAX_ERRORS = 500;

interface StoredError {
  message: string;
  url: string;
  errorMessage: string;
  errorStack: string;
  userAgent: string;
  wallet: string;
  signalId: string;
  consoleErrors: string[];
  source: string;
  timestamp: string;
  ip: string;
}

const errors: StoredError[] = [];

export function storeError(report: StoredError): void {
  errors.push(report);
  if (errors.length > MAX_ERRORS) {
    errors.splice(0, errors.length - MAX_ERRORS);
  }
}

export function getErrors(limit: number): { errors: StoredError[]; total: number } {
  const safe = Math.min(Math.max(1, limit), MAX_ERRORS);
  return {
    errors: errors.slice(-safe).reverse(),
    total: errors.length,
  };
}
