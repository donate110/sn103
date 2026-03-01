import { test, expect } from "@playwright/test";
import { ethers } from "ethers";

/**
 * On-chain write smoke tests — full lifecycle tests that actually
 * send transactions on Base Sepolia. Requires funded wallets.
 *
 * All tests run SERIALLY (one wallet = one nonce sequence).
 * Auto-skip if the test wallet has no ETH.
 */

const RPC_URL = "https://sepolia.base.org";

const ADDRESSES = {
  signalCommitment: "0x184afff99bf4d742a1168281c029c06174477bf7",
  escrow: "0xa41fc0bd7a1ae0e713c8c7c1f3c323b38b51bbcf",
  collateral: "0x47bcae6055dff70137336211be22f34c7a631626",
  creditLedger: "0xb2a4eac9baca31264894fb59a8a11c8ca1aa4efe",
  account: "0x4f42f2c714ada4c55f2a967dda6effa19e211dec",
  usdc: "0x7b8c194c848914c361cf34f2d2dd9eae74a9c9c6",
  audit: "0x95002b53f4f53a27a060502fe1f026f74e9110e9",
};

const E2E_PRIVATE_KEY = process.env.E2E_GENIUS_KEY || "";

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;
let hasFunds: boolean;

test.beforeAll(async () => {
  provider = new ethers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(E2E_PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  hasFunds = balance > ethers.parseEther("0.001");

  if (!hasFunds) {
    console.log(
      `Skipping on-chain write tests: wallet ${wallet.address} has ${ethers.formatEther(balance)} ETH (need >0.001)`,
    );
  }
});

// Force all tests to run sequentially — one wallet, one nonce.
// Retries MUST be 0: retrying a tx after nonce increment causes
// "replacement transaction underpriced" errors.
test.describe.configure({ mode: "serial", retries: 0 });

// Increase timeout for on-chain transactions
test.setTimeout(60_000);

/** Wait for RPC to reflect new state after a tx confirmation. */
const waitForSync = () => new Promise((r) => setTimeout(r, 2000));

// ─────────────────────────────────────────────
// USDC mint & approvals
// ─────────────────────────────────────────────

test("mint USDC to test wallet", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const usdc = new ethers.Contract(
    ADDRESSES.usdc,
    [
      "function mint(address to, uint256 amount) external",
      "function balanceOf(address) view returns (uint256)",
    ],
    wallet,
  );

  const balanceBefore = await usdc.balanceOf(wallet.address);
  const mintAmount = ethers.parseUnits("1000", 6);

  const tx = await usdc.mint(wallet.address, mintAmount);
  await tx.wait();
  await waitForSync();

  const balanceAfter = await usdc.balanceOf(wallet.address);
  expect(balanceAfter - balanceBefore).toBe(mintAmount);
});

test("approve USDC to Escrow", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const usdc = new ethers.Contract(
    ADDRESSES.usdc,
    [
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ],
    wallet,
  );

  const amount = ethers.parseUnits("500", 6);
  const tx = await usdc.approve(ADDRESSES.escrow, amount);
  await tx.wait();
  await waitForSync();

  const allowance = await usdc.allowance(wallet.address, ADDRESSES.escrow);
  expect(allowance).toBeGreaterThanOrEqual(amount);
});

test("approve USDC to Collateral", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const usdc = new ethers.Contract(
    ADDRESSES.usdc,
    [
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
    ],
    wallet,
  );

  const amount = ethers.parseUnits("500", 6);
  const tx = await usdc.approve(ADDRESSES.collateral, amount);
  await tx.wait();
  await waitForSync();

  const allowance = await usdc.allowance(
    wallet.address,
    ADDRESSES.collateral,
  );
  expect(allowance).toBeGreaterThanOrEqual(amount);
});

// ─────────────────────────────────────────────
// Escrow deposit/withdraw
// ─────────────────────────────────────────────

test("deposit USDC into Escrow", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    [
      "function deposit(uint256 amount) external",
      "function getBalance(address) view returns (uint256)",
    ],
    wallet,
  );

  const depositAmount = ethers.parseUnits("100", 6);
  const balanceBefore = await escrow.getBalance(wallet.address);

  const tx = await escrow.deposit(depositAmount);
  await tx.wait();
  await waitForSync();

  const balanceAfter = await escrow.getBalance(wallet.address);
  expect(balanceAfter - balanceBefore).toBe(depositAmount);
});

test("withdraw USDC from Escrow", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    [
      "function withdraw(uint256 amount) external",
      "function getBalance(address) view returns (uint256)",
    ],
    wallet,
  );

  const balance = await escrow.getBalance(wallet.address);
  test.skip(balance === 0n, "No escrow balance to withdraw");

  const withdrawAmount =
    balance > ethers.parseUnits("10", 6)
      ? ethers.parseUnits("10", 6)
      : balance;
  const tx = await escrow.withdraw(withdrawAmount);
  await tx.wait();
  await waitForSync();

  const balanceAfter = await escrow.getBalance(wallet.address);
  expect(balance - balanceAfter).toBe(withdrawAmount);
});

// ─────────────────────────────────────────────
// Collateral deposit/withdraw
// ─────────────────────────────────────────────

test("deposit USDC as collateral", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const coll = new ethers.Contract(
    ADDRESSES.collateral,
    [
      "function deposit(uint256 amount) external",
      "function getDeposit(address) view returns (uint256)",
      "function getAvailable(address) view returns (uint256)",
    ],
    wallet,
  );

  const depositAmount = ethers.parseUnits("100", 6);
  const depositBefore = await coll.getDeposit(wallet.address);

  const tx = await coll.deposit(depositAmount);
  await tx.wait();
  await waitForSync();

  const depositAfter = await coll.getDeposit(wallet.address);
  expect(depositAfter - depositBefore).toBe(depositAmount);

  const available = await coll.getAvailable(wallet.address);
  // available = deposit - locked; locked may be non-zero from prior signal activity
  expect(available).toBeGreaterThanOrEqual(depositAmount);
  expect(available).toBeLessThanOrEqual(depositAfter);
});

test("withdraw collateral", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const coll = new ethers.Contract(
    ADDRESSES.collateral,
    [
      "function withdraw(uint256 amount) external",
      "function getDeposit(address) view returns (uint256)",
      "function getAvailable(address) view returns (uint256)",
    ],
    wallet,
  );

  const available = await coll.getAvailable(wallet.address);
  test.skip(available === 0n, "No collateral to withdraw");

  const withdrawAmount =
    available > ethers.parseUnits("10", 6)
      ? ethers.parseUnits("10", 6)
      : available;
  const tx = await coll.withdraw(withdrawAmount);
  await tx.wait();
  await waitForSync();

  const availableAfter = await coll.getAvailable(wallet.address);
  expect(available - availableAfter).toBe(withdrawAmount);
});

// ─────────────────────────────────────────────
// Multi-purchase verification
// ─────────────────────────────────────────────

test("getSignalNotionalFilled returns 0 for unknown signal", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    ["function getSignalNotionalFilled(uint256) view returns (uint256)"],
    provider,
  );
  const filled = await escrow.getSignalNotionalFilled(999999);
  expect(filled).toBe(0n);
});

test("canPurchase reverts for non-existent signal", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    [
      "function canPurchase(uint256 signalId, uint256 notional) view returns (bool, string)",
    ],
    provider,
  );
  // Non-existent signals cause a revert in getSignal, which is expected behavior
  await expect(
    escrow.canPurchase(999999, ethers.parseUnits("100", 6)),
  ).rejects.toThrow();
});

test("signal 1 multi-purchase state is queryable", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    [
      "function getSignalNotionalFilled(uint256) view returns (uint256)",
      "function getPurchasesBySignal(uint256) view returns (uint256[])",
    ],
    provider,
  );

  const sc = new ethers.Contract(
    ADDRESSES.signalCommitment,
    ["function isActive(uint256) view returns (bool)"],
    provider,
  );

  // Query signal 1 — may or may not exist on current deployment
  const isActive = await sc.isActive(1);
  const filled = await escrow.getSignalNotionalFilled(1);
  const purchases = await escrow.getPurchasesBySignal(1);

  // If signal exists and is active, expect it to be queryable
  if (isActive) {
    expect(typeof filled).toBe("bigint");
    expect(Array.isArray(purchases)).toBe(true);
  }
});

// ─────────────────────────────────────────────
// Edge cases — expected failures
// ─────────────────────────────────────────────

test("escrow withdraw more than balance reverts", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    [
      "function withdraw(uint256 amount) external",
      "function getBalance(address) view returns (uint256)",
    ],
    wallet,
  );

  const balance = await escrow.getBalance(wallet.address);
  const tooMuch = balance + ethers.parseUnits("1000000", 6);

  await expect(escrow.withdraw(tooMuch)).rejects.toThrow();
});

test("collateral withdraw more than available reverts", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const coll = new ethers.Contract(
    ADDRESSES.collateral,
    ["function withdraw(uint256 amount) external"],
    wallet,
  );

  const tooMuch = ethers.parseUnits("999999999", 6);
  await expect(coll.withdraw(tooMuch)).rejects.toThrow();
});

test("deposit without USDC approval reverts", async () => {
  test.skip(!hasFunds, "No ETH — fund E2E wallet first");

  const freshWallet = ethers.Wallet.createRandom().connect(provider);

  const escrow = new ethers.Contract(
    ADDRESSES.escrow,
    ["function deposit(uint256 amount) external"],
    freshWallet,
  );

  await expect(
    escrow.deposit(ethers.parseUnits("1", 6)),
  ).rejects.toThrow();
});
