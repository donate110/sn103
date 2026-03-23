import { NextResponse } from "next/server";
import { discoverMetagraph } from "@/lib/bt-metagraph";

/**
 * Miner score history. Queries validators' admin timeseries endpoints
 * server-side, extracts per-miner weight data from weight_set events.
 *
 * Requires ADMIN_API_KEY env var to auth against validator admin endpoints.
 * Falls back gracefully if unavailable.
 */

interface HistoryPoint {
  t: number;
  weight: number;
  accuracy?: number;
  speed?: number;
  uptime?: number;
  sports_score?: number;
  attestation_score?: number;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ uid: string }> },
) {
  const { uid: uidStr } = await params;
  const uid = parseInt(uidStr, 10);
  if (isNaN(uid) || uid < 0 || uid > 65535) {
    return NextResponse.json({ error: "Invalid UID" }, { status: 400 });
  }

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { uid, history: [], error: "History unavailable (no admin key)" },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  }

  const url = new URL(request.url);
  const hours = parseInt(url.searchParams.get("hours") ?? "168", 10);

  try {
    const { nodes } = await discoverMetagraph();

    const validators = nodes.filter(
      (n) =>
        n.isValidator &&
        n.port > 0 &&
        n.ip !== "0.0.0.0" &&
        !n.ip.startsWith("10.") &&
        !n.ip.startsWith("192.168.") &&
        !n.ip.startsWith("127."),
    );

    if (validators.length === 0) {
      return NextResponse.json(
        { uid, history: [] },
        {
          headers: {
            "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
          },
        },
      );
    }

    // Query the highest-stake validator's timeseries (most reliable data)
    const topValidator = validators.sort((a, b) =>
      b.totalStake > a.totalStake ? 1 : -1,
    )[0];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(
      `http://${topValidator.ip}:${topValidator.port}/v1/admin/metrics/timeseries?hours=${hours}&bucket=3600`,
      {
        signal: controller.signal,
        cache: "no-store",
        headers: { Authorization: `Bearer ${adminKey}` },
      },
    );
    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json(
        { uid, history: [], error: `Validator returned ${res.status}` },
        {
          headers: {
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
          },
        },
      );
    }

    const data = await res.json();
    const history: HistoryPoint[] = [];

    // Extract this miner's data from weight_set telemetry buckets
    const weightBuckets = data.weights ?? [];
    for (const bucket of weightBuckets) {
      // Each weight_set event may contain top_miners in its details
      // The timeseries endpoint aggregates, so we check the raw events
      if (bucket.t && bucket.success > 0) {
        // For now, add a timestamp entry; the per-miner detail
        // requires querying /v1/telemetry directly
        history.push({ t: bucket.t, weight: 0 });
      }
    }

    // Better approach: query the telemetry endpoint for weight_set events
    // that contain per-miner breakdown
    const telRes = await fetch(
      `http://${topValidator.ip}:${topValidator.port}/v1/telemetry?category=weight_set&hours=${hours}&limit=500`,
      {
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
        headers: { Authorization: `Bearer ${adminKey}` },
      },
    ).catch(() => null);

    if (telRes?.ok) {
      const telData = await telRes.json();
      const events = telData.events ?? telData ?? [];
      const minerHistory: HistoryPoint[] = [];

      for (const event of events) {
        const details =
          typeof event.details === "string"
            ? JSON.parse(event.details)
            : event.details;
        const topMiners = details?.top_miners ?? [];
        const match = topMiners.find(
          (m: Record<string, number>) => m.uid === uid,
        );
        if (match) {
          minerHistory.push({
            t: event.timestamp ?? event.t ?? 0,
            weight: match.weight ?? 0,
            accuracy: match.accuracy,
            speed: match.speed,
            uptime: match.uptime,
            sports_score: match.sports_score,
            attestation_score: match.attestation_score,
          });
        }
      }

      if (minerHistory.length > 0) {
        minerHistory.sort((a, b) => a.t - b.t);
        return NextResponse.json(
          { uid, history: minerHistory },
          {
            headers: {
              "Cache-Control":
                "public, s-maxage=300, stale-while-revalidate=600",
            },
          },
        );
      }
    }

    return NextResponse.json(
      { uid, history: [] },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (err) {
    console.error("[network/miner/history] Failed:", err);
    return NextResponse.json({ uid, history: [] }, { status: 500 });
  }
}
