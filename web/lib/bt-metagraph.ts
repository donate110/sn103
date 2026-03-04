/**
 * Bittensor metagraph discovery for Djinn web client.
 *
 * Queries the subtensor chain via the NeuronInfoRuntimeApi to discover
 * validator and miner axon endpoints. Caches results for 60 seconds.
 * Falls back to VALIDATOR_URL / MINER_URL env vars when discovery fails.
 *
 * Server-side only (uses process.env, fetch with AbortSignal).
 */

import { ScaleReader, hexToBytes } from "./scale";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUBTENSOR_HTTP: Record<string, string[]> = {
  finney: [
    "https://entrypoint-finney.opentensor.ai",
    "https://lite.chain.opentensor.ai",
  ],
  mainnet: [
    "https://entrypoint-finney.opentensor.ai",
    "https://lite.chain.opentensor.ai",
  ],
  test: ["https://test.finney.opentensor.ai"],
  local: ["http://127.0.0.1:9933"],
};

function getBtConfig() {
  const netuid = parseInt(process.env.BT_NETUID || "103", 10);
  const network = process.env.BT_NETWORK || "finney";
  const customRpc = process.env.BT_RPC_URL;
  const rpcUrls = customRpc
    ? [customRpc]
    : SUBTENSOR_HTTP[network] ?? SUBTENSOR_HTTP.finney;
  return { netuid, network, rpcUrls };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredNode {
  uid: number;
  hotkey: string; // hex-encoded 32-byte public key
  coldkey: string; // hex-encoded 32-byte owner key
  ip: string;
  port: number;
  isValidator: boolean;
  stake: bigint; // alpha stake from NeuronInfoLite (rao)
  alphaStake: bigint; // alpha stake from SubnetState (rao)
  taoStake: bigint; // tao stake from SubnetState (rao)
  totalStake: bigint; // weighted alpha + tao from SubnetState (rao)
  rank: number;
  emission: bigint;
  incentive: number;
  consensus: number;
  trust: number;
  validatorTrust: number;
  dividends: number;
}

interface MetagraphSnapshot {
  nodes: DiscoveredNode[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
let cached: MetagraphSnapshot | null = null;

/** Force-clear the in-memory metagraph cache. */
export function clearMetagraphCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// SCALE decoding — NeuronInfoLite
// ---------------------------------------------------------------------------

/**
 * Decode the SCALE response from `NeuronInfoRuntimeApi_get_neurons_lite`.
 *
 * Field order matches the Rust struct in subtensor:
 *   hotkey, coldkey, uid, netuid, active,
 *   axon_info { block, version, ip, port, ip_type, protocol, ph1, ph2 },
 *   prometheus_info { block, version, ip, port, ip_type },
 *   stake: Vec<(AccountId, Compact<u64>)>,
 *   rank, emission, incentive, consensus, trust, validator_trust, dividends,
 *   last_update, validator_permit, pruning_score
 */
function decodeNeuronsLite(bytes: Uint8Array): DiscoveredNode[] {
  const r = new ScaleReader(bytes);
  const count = r.readVecLength();
  const nodes: DiscoveredNode[] = [];

  for (let i = 0; i < count; i++) {
    const hotkey = r.readAccountId();
    const coldkey = r.readAccountId();
    const uid = r.readCompactNumber();
    r.readCompact(); // netuid
    r.readBool(); // active

    // AxonInfo
    r.readU64(); // block
    r.readU32(); // version
    const ipInt = r.readU128();
    const port = r.readU16();
    const ipType = r.readU8();
    r.skip(3); // protocol, ph1, ph2

    // PrometheusInfo
    r.readU64(); // block
    r.readU32(); // version
    r.readU128(); // ip
    r.readU16(); // port
    r.readU8(); // ip_type

    // stake: Vec<(AccountId, Compact<AlphaCurrency>)>
    const stakeLen = r.readVecLength();
    let totalStake = 0n;
    for (let s = 0; s < stakeLen; s++) {
      r.skip(32); // staker AccountId
      totalStake += r.readCompact();
    }

    // rank, emission, incentive, consensus, trust, validator_trust, dividends
    const rank = r.readCompactNumber();
    const emission = r.readCompact();
    const incentive = r.readCompactNumber();
    const consensus = r.readCompactNumber();
    const trust = r.readCompactNumber();
    const validatorTrust = r.readCompactNumber();
    const dividends = r.readCompactNumber();

    r.readCompact(); // last_update
    const validatorPermit = r.readBool();
    r.readCompact(); // pruning_score

    const ip = ipIntToString(ipInt, ipType);

    nodes.push({
      uid,
      hotkey: bytesToHex(hotkey),
      coldkey: bytesToHex(coldkey),
      ip,
      port,
      isValidator: validatorPermit,
      stake: totalStake,
      alphaStake: totalStake, // fallback; overwritten by SubnetState if available
      taoStake: 0n,
      totalStake: totalStake,
      rank,
      emission,
      incentive,
      consensus,
      trust,
      validatorTrust,
      dividends,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// SCALE decoding — SubnetState (stake arrays)
// ---------------------------------------------------------------------------

/**
 * Decode per-UID stake arrays from `SubnetInfoRuntimeApi_get_subnet_state`.
 *
 * SubnetState field order:
 *   netuid, hotkeys, coldkeys, active, validator_permit,
 *   pruning_score, last_update, emission, dividends, incentives, consensus,
 *   trust, rank, block_at_registration,
 *   alpha_stake, tao_stake, total_stake, emission_history
 *
 * We skip through all preceding fields to reach the three stake arrays.
 */
function decodeSubnetStateStakes(
  bytes: Uint8Array,
): { alphaStake: bigint[]; taoStake: bigint[]; totalStake: bigint[] } | null {
  const r = new ScaleReader(bytes);

  // Option<SubnetState>: 0x01 = Some
  const optionTag = r.readU8();
  if (optionTag !== 1) return null;

  r.readCompact(); // netuid

  // hotkeys: Vec<AccountId>
  const nHotkeys = r.readVecLength();
  r.skip(nHotkeys * 32);

  // coldkeys: Vec<AccountId>
  const nColdkeys = r.readVecLength();
  r.skip(nColdkeys * 32);

  // active: Vec<bool>
  const nActive = r.readVecLength();
  r.skip(nActive);

  // validator_permit: Vec<bool>
  const nPermit = r.readVecLength();
  r.skip(nPermit);

  // Skip compact Vec arrays: pruning_score, last_update, emission,
  // dividends, incentives, consensus, trust, rank, block_at_registration
  for (let f = 0; f < 9; f++) {
    const len = r.readVecLength();
    for (let i = 0; i < len; i++) r.readCompact();
  }

  // alpha_stake: Vec<Compact<u64>>
  const nAlpha = r.readVecLength();
  const alphaStake: bigint[] = [];
  for (let i = 0; i < nAlpha; i++) alphaStake.push(r.readCompact());

  // tao_stake: Vec<Compact<u64>>
  const nTao = r.readVecLength();
  const taoStake: bigint[] = [];
  for (let i = 0; i < nTao; i++) taoStake.push(r.readCompact());

  // total_stake: Vec<Compact<u64>>
  const nTotal = r.readVecLength();
  const totalStake: bigint[] = [];
  for (let i = 0; i < nTotal; i++) totalStake.push(r.readCompact());

  return { alphaStake, taoStake, totalStake };
}

function ipIntToString(ipInt: bigint, ipType: number): string {
  if (ipInt === 0n) return "0.0.0.0";
  if (ipType === 4 || ipInt <= 0xffffffffn) {
    const n = Number(ipInt);
    return `${(n >> 24) & 0xff}.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
  }
  // IPv6 — rare, return raw for now
  return ipInt.toString();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Reject private/loopback/link-local IPs to prevent SSRF. */
function isPublicIp(ip: string): boolean {
  if (ip === "0.0.0.0" || ip.startsWith("127.") || ip.startsWith("10.")) return false;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return false;
  }
  if (ip.startsWith("192.168.")) return false;
  if (ip.startsWith("169.254.")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

async function callRpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

/** Try RPC call against multiple endpoints, returning first success. */
async function callRpcWithFallback(
  rpcUrls: string[],
  method: string,
  params: unknown[],
): Promise<string> {
  let lastError: Error | null = null;
  for (const url of rpcUrls) {
    try {
      return await callRpc(url, method, params);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[bt-metagraph] RPC ${url} failed for ${method}:`, lastError.message);
    }
  }
  throw lastError ?? new Error("No RPC endpoints available");
}

async function fetchNeurons(netuid: number, rpcUrls: string[]): Promise<DiscoveredNode[]> {
  // SCALE-encode netuid as u16 little-endian
  const lo = netuid & 0xff;
  const hi = (netuid >> 8) & 0xff;
  const callData = "0x" + lo.toString(16).padStart(2, "0") + hi.toString(16).padStart(2, "0");

  // Fetch neurons and subnet state in parallel
  const [neuronsResult, stateResult] = await Promise.all([
    callRpcWithFallback(rpcUrls, "state_call", [
      "NeuronInfoRuntimeApi_get_neurons_lite",
      callData,
    ]),
    callRpcWithFallback(rpcUrls, "state_call", [
      "SubnetInfoRuntimeApi_get_subnet_state",
      callData,
    ]).catch((err) => {
      console.warn("[bt-metagraph] SubnetState fetch failed, using alpha-only stakes:", err);
      return null;
    }),
  ]);

  const nodes = decodeNeuronsLite(hexToBytes(neuronsResult));

  // Merge SubnetState stake data if available
  if (stateResult) {
    try {
      const stakes = decodeSubnetStateStakes(hexToBytes(stateResult));
      if (stakes) {
        for (const node of nodes) {
          if (node.uid < stakes.alphaStake.length) {
            node.alphaStake = stakes.alphaStake[node.uid];
            node.taoStake = stakes.taoStake[node.uid];
            node.totalStake = stakes.totalStake[node.uid];
          }
        }
      }
    } catch (err) {
      console.warn("[bt-metagraph] SubnetState decode failed:", err);
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function discoverMetagraph(): Promise<MetagraphSnapshot> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const { netuid, rpcUrls } = getBtConfig();

  try {
    const nodes = await fetchNeurons(netuid, rpcUrls);
    cached = { nodes, fetchedAt: now };
    return cached;
  } catch (err) {
    console.warn("[bt-metagraph] Failed to fetch metagraph:", err);
    if (cached) return cached; // stale cache
    return { nodes: [], fetchedAt: 0 };
  }
}

/**
 * Discover the best validator URL from the metagraph.
 * Picks the highest-stake validator with a public IP.
 */
export async function discoverValidatorUrl(): Promise<string | null> {
  const { nodes } = await discoverMetagraph();
  const validators = nodes
    .filter((n) => n.isValidator && n.port > 0 && isPublicIp(n.ip))
    .sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0));

  if (validators.length === 0) return null;
  return `http://${validators[0].ip}:${validators[0].port}`;
}

/**
 * Discover all validator URLs from the metagraph.
 * Returns them sorted by stake (highest first).
 */
export async function discoverValidatorUrls(): Promise<string[]> {
  const { nodes } = await discoverMetagraph();
  return nodes
    .filter((n) => n.isValidator && n.port > 0 && isPublicIp(n.ip))
    .sort((a, b) => (b.totalStake > a.totalStake ? 1 : b.totalStake < a.totalStake ? -1 : 0))
    .map((n) => `http://${n.ip}:${n.port}`);
}

/**
 * Discover all miner nodes from the metagraph.
 * Returns non-validator nodes with public IPs, sorted by UID.
 * On testnet where all nodes may have validatorPermit=true,
 * probes public nodes for `odds_api_connected` to identify miners.
 */
export async function discoverMiners(): Promise<DiscoveredNode[]> {
  const { nodes } = await discoverMetagraph();
  const publicNodes = nodes.filter((n) => n.port > 0 && isPublicIp(n.ip));

  // Prefer nodes without validator permit (classic miners)
  const miners = publicNodes.filter((n) => !n.isValidator);
  if (miners.length > 0) return miners.sort((a, b) => a.uid - b.uid);

  // Fallback: probe all public nodes for miner health signature
  const identified: DiscoveredNode[] = [];
  for (const n of publicNodes) {
    try {
      const url = `http://${n.ip}:${n.port}`;
      const resp = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = await resp.json();
      if (data.odds_api_connected !== undefined) identified.push(n);
    } catch {
      continue;
    }
  }

  return identified.sort((a, b) => a.uid - b.uid);
}

/**
 * Discover a miner URL from the metagraph.
 * First tries non-validator nodes; if none found, probes all nodes' /health
 * for `odds_api_connected` to identify miners (on testnet, all nodes may
 * have validatorPermit=true).
 */
export async function discoverMinerUrl(): Promise<string | null> {
  const miners = await discoverMiners();
  if (miners.length > 0) return `http://${miners[0].ip}:${miners[0].port}`;
  return null;
}
