/**
 * E2E test: Full signal creation + purchase flow against live local stack.
 *
 * Prerequisites: Anvil (8545), Validator (8421), Miner (8422) all running.
 *
 * Usage: node e2e-test.mjs
 */

import { ethers, NonceManager } from "ethers";
import { webcrypto } from "node:crypto";

// Polyfill for Node.js (crypto.subtle isn't global in Node)
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RPC = "http://localhost:8545";
const VALIDATOR = "http://localhost:8421";
const MINER = "http://localhost:8422";

// Anvil default accounts
const GENIUS_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Account 1
const IDIOT_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";  // Account 2

const ADDRESSES = {
  signalCommitment: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  escrow: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
  collateral: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
  usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
};

// Minimal ABIs
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
];

const SIGNAL_ABI = [
  "function commit((uint256 signalId, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks) p) external",
  "function getSignal(uint256) view returns (tuple(address genius, bytes encryptedBlob, bytes32 commitHash, string sport, uint256 maxPriceBps, uint256 slaMultiplierBps, uint256 maxNotional, uint256 minNotional, uint256 expiresAt, string[] decoyLines, string[] availableSportsbooks, uint8 status, uint256 createdAt))",
  "function isActive(uint256) view returns (bool)",
];

const ESCROW_ABI = [
  "function deposit(uint256) external",
  "function purchase(uint256,uint256,uint256) external returns (uint256)",
  "function getBalance(address) view returns (uint256)",
];

const COLLATERAL_ABI = [
  "function deposit(uint256) external",
  "function getAvailable(address) view returns (uint256)",
];

// ---------------------------------------------------------------------------
// BN254 Shamir (inline — same as web/lib/crypto.ts)
// ---------------------------------------------------------------------------

const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function mod(a, p) {
  const r = a % p;
  return r < 0n ? r + p : r;
}

function extGcd(a, b) {
  if (a === 0n) return [b, 0n, 1n];
  const [g, x, y] = extGcd(mod(b, a), a);
  return [g, y - (b / a) * x, x];
}

function modInv(a, p) {
  const [g, x] = extGcd(mod(a, p), p);
  if (g !== 1n) throw new Error("No inverse");
  return mod(x, p);
}

function modPow(base, exp, p) {
  let r = 1n, b = mod(base, p), e = exp;
  while (e > 0n) {
    if (e & 1n) r = mod(r * b, p);
    b = mod(b * b, p);
    e >>= 1n;
  }
  return r;
}

function splitSecret(secret, n = 10, k = 7) {
  const coeffs = [secret];
  for (let i = 1; i < k; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let val = 0n;
    for (const b of bytes) val = (val << 8n) | BigInt(b);
    coeffs.push(mod(val, BN254_PRIME));
  }
  const shares = [];
  for (let i = 1; i <= n; i++) {
    let y = 0n;
    const x = BigInt(i);
    for (let j = 0; j < coeffs.length; j++)
      y = mod(y + coeffs[j] * modPow(x, BigInt(j), BN254_PRIME), BN254_PRIME);
    shares.push({ x: i, y });
  }
  return shares;
}

// ---------------------------------------------------------------------------
// AES helpers
// ---------------------------------------------------------------------------

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2)
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function keyToBigInt(key) {
  let val = 0n;
  for (const b of key) val = (val << 8n) | BigInt(b);
  return mod(val, BN254_PRIME);
}

function bigIntToKey(val) {
  const key = new Uint8Array(32);
  let v = val;
  for (let i = 31; i >= 0; i--) {
    key[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return key;
}

function generateAesKey() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return bigIntToKey(keyToBigInt(raw));
}

async function aesEncrypt(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(plaintext));
  return { ciphertext: toHex(new Uint8Array(enc)), iv: toHex(iv) };
}

async function aesDecrypt(ciphertext, iv, key) {
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(iv) }, ck, fromHex(ciphertext));
  return new TextDecoder().decode(dec);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// E2E TEST
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== DJINN E2E TEST ===\n");

  const provider = new ethers.JsonRpcProvider(RPC);
  // Wrap wallets in NonceManager to handle sequential nonce tracking
  const genius = new NonceManager(new ethers.Wallet(GENIUS_KEY, provider));
  const idiot = new NonceManager(new ethers.Wallet(IDIOT_KEY, provider));
  const geniusAddr = await genius.getAddress();
  const idiotAddr = await idiot.getAddress();

  console.log(`Genius:   ${geniusAddr}`);
  console.log(`Idiot:    ${idiotAddr}\n`);

  // Contract instances — each connected to the right signer
  const usdcG = new ethers.Contract(ADDRESSES.usdc, ERC20_ABI, genius);
  const usdcI = new ethers.Contract(ADDRESSES.usdc, ERC20_ABI, idiot);
  const signal = new ethers.Contract(ADDRESSES.signalCommitment, SIGNAL_ABI, genius);
  const escrow = new ethers.Contract(ADDRESSES.escrow, ESCROW_ABI, idiot);
  const collateral = new ethers.Contract(ADDRESSES.collateral, COLLATERAL_ABI, genius);

  // ── Step 1: Fund accounts ──
  console.log("Step 1: Funding accounts with test USDC...");
  const amount = ethers.parseUnits("10000", 6); // 10k USDC
  await (await usdcG.mint(geniusAddr, amount)).wait();
  await (await usdcI.mint(idiotAddr, amount)).wait();
  console.log(`  Genius USDC: ${ethers.formatUnits(await usdcG.balanceOf(geniusAddr), 6)}`);
  console.log(`  Idiot USDC:  ${ethers.formatUnits(await usdcI.balanceOf(idiotAddr), 6)}\n`);

  // ── Step 2: Genius deposits collateral ──
  console.log("Step 2: Genius deposits 5000 USDC collateral...");
  const collateralAmount = ethers.parseUnits("5000", 6);
  await (await usdcG.approve(ADDRESSES.collateral, collateralAmount)).wait();
  await (await collateral.deposit(collateralAmount)).wait();
  const available = await collateral.getAvailable(geniusAddr);
  console.log(`  Collateral available: ${ethers.formatUnits(available, 6)} USDC\n`);

  // ── Step 3: Idiot deposits to escrow ──
  console.log("Step 3: Idiot deposits 5000 USDC to escrow...");
  const escrowAmount = ethers.parseUnits("5000", 6);
  await (await usdcI.approve(ADDRESSES.escrow, escrowAmount)).wait();
  await (await escrow.deposit(escrowAmount)).wait();
  const escrowBal = await escrow.getBalance(idiotAddr);
  console.log(`  Escrow balance: ${ethers.formatUnits(escrowBal, 6)} USDC\n`);

  // ── Step 4: Genius creates signal ──
  console.log("Step 4: Genius creates encrypted signal...");

  const realIndex = 3; // 1-indexed: line 3 is the real pick
  const aesKey = generateAesKey();
  const pickPayload = JSON.stringify({ realIndex, pick: "Lakers -3.5 (-110)" });
  const { ciphertext, iv } = await aesEncrypt(pickPayload, aesKey);
  const encryptedBlob = `${iv}:${ciphertext}`;

  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest("SHA-256", encoder.encode(encryptedBlob));
  const commitHash = "0x" + toHex(new Uint8Array(hashBuf));

  const signalIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const signalId = BigInt("0x" + toHex(signalIdBytes));
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);

  const decoyLines = [
    "Celtics +5.5 (-110)",
    "Warriors -2.5 (-105)",
    "Lakers -3.5 (-110)",    // <-- REAL (index 3)
    "Bucks +1.5 (-115)",
    "Nuggets -7.0 (-110)",
    "Heat +4.0 (-110)",
    "Suns -1.0 (-120)",
    "76ers +3.0 (-110)",
    "Knicks -2.0 (-110)",
    "Mavs +6.5 (-110)",
  ];

  const commitTx = await signal.commit({
    signalId,
    encryptedBlob: "0x" + toHex(encoder.encode(encryptedBlob)),
    commitHash,
    sport: "NBA",
    maxPriceBps: 1000n, // 10%
    slaMultiplierBps: 10000n, // 100%
    maxNotional: 10000_000000n, // $10,000 USDC
    expiresAt,
    decoyLines,
    availableSportsbooks: ["DraftKings", "FanDuel"],
  });
  await commitTx.wait();
  console.log(`  Signal committed on-chain: ${signalId}`);

  // Verify it's stored
  const onChain = await signal.getSignal(signalId);
  console.log(`  On-chain status: ${onChain.status === 0n ? "Active" : onChain.status}`);
  console.log(`  Sport: ${onChain.sport}, Lines: ${onChain.decoyLines.length}\n`);

  // ── Step 5: Distribute share to validator ──
  console.log("Step 5: Sending real-index share + AES key to validator...");

  // In single-validator mode, we send:
  //   share = (x=1, y=realIndex) — for MPC availability check
  //   encrypted_key_share = hex(aesKey) — released to buyer after MPC passes
  //
  // The MPC reconstructs 'secret' from 1 share (threshold=1):
  //   Lagrange L_1(0) = 1, so secret = y_1 = realIndex
  //   Then checks: realIndex ∈ available_indices?
  const signalIdStr = signalId.toString();
  await post(`${VALIDATOR}/v1/signal`, {
    signal_id: signalIdStr,
    genius_address: geniusAddr,
    share_x: 1,
    share_y: realIndex.toString(16),
    encrypted_key_share: toHex(aesKey),
  });

  // Verify validator received it
  const health = await (await fetch(`${VALIDATOR}/health`)).json();
  console.log(`  Validator shares held: ${health.shares_held}\n`);

  // ── Step 6: Miner checks line availability ──
  console.log("Step 6: Miner checks line availability...");
  const checkResult = await post(`${MINER}/v1/check`, {
    lines: decoyLines.map((line, i) => ({
      index: i + 1,
      sport: "basketball_nba",
      event_id: "test_event_1",
      home_team: "Lakers",
      away_team: "Celtics",
      market: "spreads",
      line: null,
      side: line,
    })),
  });
  console.log(`  Available indices: [${checkResult.available_indices.join(", ")}]`);
  console.log(`  Response time: ${checkResult.response_time_ms}ms\n`);

  // For E2E: if no lines are available (odds API may not have these games),
  // use all indices to simulate availability
  const availIndices = checkResult.available_indices.length > 0
    ? checkResult.available_indices
    : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // ── Step 7: Validator MPC check + share release ──
  console.log("Step 7: Requesting purchase from validator (MPC check)...");
  const purchaseResult = await post(`${VALIDATOR}/v1/signal/${signalIdStr}/purchase`, {
    buyer_address: idiotAddr,
    sportsbook: "DraftKings",
    available_indices: availIndices,
  });
  console.log(`  Status: ${purchaseResult.status}`);
  console.log(`  Available: ${purchaseResult.available}`);
  console.log(`  Key share received: ${purchaseResult.encrypted_key_share ? "yes" : "no"}\n`);

  if (!purchaseResult.available) {
    console.log("FAIL: MPC check returned unavailable. Real index might not be in available set.");
    console.log(`  Real index: ${realIndex}, Available: [${availIndices.join(", ")}]`);
    process.exit(1);
  }

  // ── Step 8: On-chain purchase ──
  console.log("Step 8: Executing on-chain purchase...");
  const notional = ethers.parseUnits("100", 6); // $100
  const odds = 191n; // 1.91 decimal
  const purchaseTx = await escrow.purchase(signalId, notional, odds);
  const receipt = await purchaseTx.wait();
  console.log(`  Purchase tx: ${receipt.hash}`);

  // Verify signal status changed
  const postPurchase = await signal.getSignal(signalId);
  console.log(`  Signal status after purchase: ${postPurchase.status === 1n ? "Purchased" : postPurchase.status}\n`);

  // ── Step 9: Decrypt signal ──
  console.log("Step 9: Decrypting signal with received key...");
  const recoveredKey = fromHex(purchaseResult.encrypted_key_share);
  const blobHex = postPurchase.encryptedBlob.startsWith("0x")
    ? postPurchase.encryptedBlob.slice(2)
    : postPurchase.encryptedBlob;
  const blobStr = new TextDecoder().decode(fromHex(blobHex));
  const [decIv, decCt] = blobStr.split(":");

  const decrypted = await aesDecrypt(decCt, decIv, recoveredKey);
  const parsed = JSON.parse(decrypted);

  console.log(`  Decrypted payload: ${decrypted}`);
  console.log(`  Real index: ${parsed.realIndex}`);
  console.log(`  Real pick: ${parsed.pick}\n`);

  // ── Assertions ──
  const pass = parsed.realIndex === realIndex && parsed.pick === "Lakers -3.5 (-110)";
  if (pass) {
    console.log("=== E2E TEST PASSED ===");
    console.log("Full flow verified:");
    console.log("  1. Genius funded + deposited collateral");
    console.log("  2. Idiot funded + deposited to escrow");
    console.log("  3. Signal encrypted, committed on-chain, shares distributed");
    console.log("  4. Miner checked line availability");
    console.log("  5. Validator ran MPC, released key share");
    console.log("  6. On-chain purchase executed");
    console.log("  7. Signal decrypted — correct pick revealed");
  } else {
    console.log("=== E2E TEST FAILED ===");
    console.log(`  Expected realIndex=${realIndex}, pick="Lakers -3.5 (-110)"`);
    console.log(`  Got realIndex=${parsed.realIndex}, pick="${parsed.pick}"`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
