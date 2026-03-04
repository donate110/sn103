import { NextResponse } from "next/server";
import { ss58ToHex } from "@/lib/ss58";

const TAOSTATS_API = "https://api.taostats.io/api";
const NETUID = process.env.BT_NETUID ?? "103";

/** Cache the delegate map for 10 minutes. */
let cache: { map: Record<string, string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Returns a map of hex key → delegate name.
 * Sources:
 * 1. Taostats dTAO validator list for the subnet (address→name, matched by hotkey)
 * 2. Taostats root-network validator list (coldkey/hotkey→name)
 *
 * Keys include both hotkeys and coldkeys so SN103 nodes can be matched
 * even when they use a different hotkey than their root-network delegate key.
 */
export async function GET() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(cache.map, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  }

  const apiKey = process.env.TAOSTATS_API_KEY;
  if (!apiKey) {
    console.warn("[delegates] TAOSTATS_API_KEY not set — names unavailable");
    return NextResponse.json({}, { status: 200 });
  }

  const headers = { Authorization: apiKey };

  try {
    const map: Record<string, string> = {};

    // Fetch both sources in parallel
    const [dtaoRes, validatorRes] = await Promise.all([
      fetch(`${TAOSTATS_API}/dtao/validator/available/v1?netuid=${NETUID}&limit=200`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${TAOSTATS_API}/validator/latest/v1?limit=200&order=stake_desc`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);

    // 1. dTAO validators — these addresses are hotkeys of SN103 stakers
    if (dtaoRes.ok) {
      const dtao = await dtaoRes.json();
      for (const entry of dtao.data ?? []) {
        if (!entry.name) continue;
        const ss58 = entry.address?.ss58;
        if (!ss58) continue;
        try {
          const hex = ss58ToHex(ss58);
          map[hex] = entry.name;
        } catch { /* skip invalid addresses */ }
      }
    }

    // 2. Root-network validators — match by both coldkey and hotkey
    if (validatorRes.ok) {
      const validators = await validatorRes.json();
      for (const v of validators.data ?? []) {
        if (!v.name) continue;
        for (const key of [v.hotkey?.ss58, v.coldkey?.ss58]) {
          if (!key) continue;
          try {
            const hex = ss58ToHex(key);
            if (!map[hex]) map[hex] = v.name;
          } catch { /* skip invalid addresses */ }
        }
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
