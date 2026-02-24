import { NextResponse } from "next/server";
import { ss58ToHex } from "@/lib/ss58";

const DELEGATES_URL =
  "https://raw.githubusercontent.com/opentensor/bittensor-delegates/main/public/delegates.json";

interface DelegateEntry {
  name: string;
  url: string;
  description: string;
}

type DelegateRegistry = Record<string, DelegateEntry>;

/** Cache the delegate map for 10 minutes. */
let cache: { map: Record<string, string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Returns a map of hex hotkey → delegate name.
 * Fetches the opentensor delegates registry and converts SS58 keys to hex.
 */
export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.map, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  }

  try {
    const res = await fetch(DELEGATES_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`delegates.json fetch failed: ${res.status}`);

    const registry: DelegateRegistry = await res.json();
    const map: Record<string, string> = {};

    for (const [ss58, info] of Object.entries(registry)) {
      try {
        const hex = ss58ToHex(ss58);
        map[hex] = info.name;
      } catch {
        // Skip entries with invalid SS58 addresses
      }
    }

    cache = { map, fetchedAt: now };
    return NextResponse.json(map, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (err) {
    console.error("[delegates] Failed to fetch delegate names:", err);
    return NextResponse.json(cache?.map ?? {}, { status: cache ? 200 : 502 });
  }
}
