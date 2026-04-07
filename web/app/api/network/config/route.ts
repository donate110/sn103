import { NextResponse } from "next/server";
import { ADDRESSES } from "@/lib/contracts";
import { discoverMetagraph, isPublicIp } from "@/lib/bt-metagraph";

/**
 * GET /api/network/config
 *
 * Returns validator public keys, Shamir parameters, and contract addresses
 * needed by the SDK for signal creation. This data is network-level
 * configuration that doesn't change per signal. Clients should cache it.
 *
 * No authentication required.
 */

// Fallback validators when metagraph discovery is unavailable.
// Override via VALIDATOR_ENDPOINTS env var (comma-separated "uid:name:endpoint").
const DEFAULT_VALIDATOR_ENDPOINTS = [
  "2:Yuma:http://34.58.165.14:8421",
  "41:Djinn:http://37.60.251.252:8421",
  "189:Kooltek68:http://161.97.150.248:8421",
  "213:TAO.com:http://3.150.72.96:8421",
];

function parseFallbackValidators(): { uid: number; name: string; endpoint: string }[] {
  const raw = process.env.VALIDATOR_ENDPOINTS;
  const entries = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_VALIDATOR_ENDPOINTS;
  return entries.map((entry) => {
    const [uid, name, ...rest] = entry.split(":");
    return { uid: parseInt(uid, 10), name, endpoint: rest.join(":") };
  });
}

async function discoverValidators(): Promise<{ uid: number; name: string; endpoint: string }[]> {
  try {
    const { nodes } = await discoverMetagraph();
    const validators = nodes
      .filter((n) => n.isValidator && n.port > 0 && isPublicIp(n.ip))
      .sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0));
    if (validators.length > 0) {
      return validators.map((v) => ({
        uid: v.uid,
        name: `UID ${v.uid}`,
        endpoint: `http://${v.ip}:${v.port}`,
      }));
    }
  } catch (err) {
    console.warn("[network/config] Metagraph discovery failed, using fallback:", err);
  }
  return parseFallbackValidators();
}

// Cache for 5 minutes
let cachedConfig: { data: unknown; expiresAt: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchValidatorIdentity(v: { uid: number; name: string; endpoint: string }) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${v.endpoint}/v1/identity`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return { ...v, online: false, pubkey: null };
    const data = await resp.json();
    return {
      ...v,
      online: true,
      pubkey: data.pubkey || data.public_key || null,
    };
  } catch {
    return { ...v, online: false, pubkey: null };
  }
}

export async function GET() {
  const now = Date.now();
  if (cachedConfig && now < cachedConfig.expiresAt) {
    return NextResponse.json(cachedConfig.data, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }

  // Discover validators from metagraph (falls back to env/hardcoded list)
  const validators = await discoverValidators();

  // Fetch validator identities in parallel
  const results = await Promise.all(validators.map(fetchValidatorIdentity));

  const config = {
    validators: results
      .filter((v) => v.online)
      .map((v) => ({
        uid: v.uid,
        name: v.name,
        endpoint: v.endpoint,
        pubkey: v.pubkey,
      })),
    chain_id: parseInt(
      process.env.NEXT_PUBLIC_BASE_CHAIN_ID || "84532",
      10,
    ),
    contracts: {
      signal_commitment: ADDRESSES.signalCommitment,
      escrow: ADDRESSES.escrow,
      collateral: ADDRESSES.collateral,
      account: ADDRESSES.account,
      audit: ADDRESSES.audit,
      credit_ledger: ADDRESSES.creditLedger,
      key_recovery: ADDRESSES.keyRecovery,
      usdc: ADDRESSES.usdc,
    },
    shamir: {
      n: parseInt(process.env.SHAMIR_MAX || "10", 10),
      k: parseInt(process.env.SHAMIR_MIN || "3", 10),
    },
    cached_at: new Date().toISOString(),
  };

  cachedConfig = { data: config, expiresAt: now + CACHE_TTL };
  return NextResponse.json(config, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
