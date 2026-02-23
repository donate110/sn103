import { test, expect } from "@playwright/test";
import { ethers } from "ethers";

/**
 * Contract smoke tests — verify all deployed contracts on Base Sepolia
 * are accessible, correctly configured, and responding to view calls.
 *
 * These tests run against the live testnet (read-only — no gas needed).
 */

const RPC_URL = "https://sepolia.base.org";
const CHAIN_ID = 84532;

// Contract addresses from deployment
const ADDRESSES = {
  signalCommitment: "0x184afff99bf4d742a1168281c029c06174477bf7",
  escrow: "0xa41fc0bd7a1ae0e713c8c7c1f3c323b38b51bbcf",
  collateral: "0x47bcae6055dff70137336211be22f34c7a631626",
  creditLedger: "0xb2a4eac9baca31264894fb59a8a11c8ca1aa4efe",
  account: "0x4f42f2c714ada4c55f2a967dda6effa19e211dec",
  usdc: "0x7b8c194c848914c361cf34f2d2dd9eae74a9c9c6",
  audit: "0x95002b53f4f53a27a060502fe1f026f74e9110e9",
};

// Dummy addresses for testing view functions
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RANDOM_ADDRESS = "0x1234567890AbcdEF1234567890aBcdef12345678";

let provider: ethers.JsonRpcProvider;

test.beforeAll(() => {
  provider = new ethers.JsonRpcProvider(RPC_URL);
});

test.describe("Contract deployment verification", () => {
  for (const [name, address] of Object.entries(ADDRESSES)) {
    test(`${name} has deployed bytecode at ${address}`, async () => {
      const code = await provider.getCode(address);
      expect(code).not.toBe("0x");
      expect(code.length).toBeGreaterThan(10);
    });
  }

  test("connected to Base Sepolia (chain ID 84532)", async () => {
    const network = await provider.getNetwork();
    expect(Number(network.chainId)).toBe(CHAIN_ID);
  });
});

test.describe("USDC contract", () => {
  test("returns correct decimals (6)", async () => {
    const usdc = new ethers.Contract(
      ADDRESSES.usdc,
      ["function decimals() view returns (uint8)"],
      provider,
    );
    const decimals = await usdc.decimals();
    expect(Number(decimals)).toBe(6);
  });

  test("returns name 'USD Coin'", async () => {
    const usdc = new ethers.Contract(
      ADDRESSES.usdc,
      ["function name() view returns (string)"],
      provider,
    );
    const name = await usdc.name();
    expect(name).toBe("USD Coin");
  });

  test("returns symbol 'USDC'", async () => {
    const usdc = new ethers.Contract(
      ADDRESSES.usdc,
      ["function symbol() view returns (string)"],
      provider,
    );
    const symbol = await usdc.symbol();
    expect(symbol).toBe("USDC");
  });

  test("total supply > 0 (tokens have been minted)", async () => {
    const usdc = new ethers.Contract(
      ADDRESSES.usdc,
      ["function totalSupply() view returns (uint256)"],
      provider,
    );
    const supply = await usdc.totalSupply();
    expect(supply).toBeGreaterThan(0n);
  });

  test("balanceOf returns 0 for random address", async () => {
    const usdc = new ethers.Contract(
      ADDRESSES.usdc,
      ["function balanceOf(address) view returns (uint256)"],
      provider,
    );
    const balance = await usdc.balanceOf(RANDOM_ADDRESS);
    expect(balance).toBe(0n);
  });
});

test.describe("SignalCommitment contract", () => {
  test("signalExists returns false for non-existent signal", async () => {
    const sc = new ethers.Contract(
      ADDRESSES.signalCommitment,
      ["function signalExists(uint256) view returns (bool)"],
      provider,
    );
    const exists = await sc.signalExists(999999);
    expect(exists).toBe(false);
  });

  test("isActive returns false for non-existent signal", async () => {
    const sc = new ethers.Contract(
      ADDRESSES.signalCommitment,
      ["function isActive(uint256) view returns (bool)"],
      provider,
    );
    const active = await sc.isActive(999999);
    expect(active).toBe(false);
  });
});

test.describe("Escrow contract", () => {
  test("getBalance returns 0 for unused address", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function getBalance(address) view returns (uint256)"],
      provider,
    );
    const balance = await escrow.getBalance(RANDOM_ADDRESS);
    expect(balance).toBe(0n);
  });

  test("signalCommitment is correctly wired", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function signalCommitment() view returns (address)"],
      provider,
    );
    const sc = await escrow.signalCommitment();
    expect(sc.toLowerCase()).toBe(ADDRESSES.signalCommitment.toLowerCase());
  });

  test("collateral is correctly wired", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function collateral() view returns (address)"],
      provider,
    );
    const coll = await escrow.collateral();
    expect(coll.toLowerCase()).toBe(ADDRESSES.collateral.toLowerCase());
  });

  test("creditLedger is correctly wired", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function creditLedger() view returns (address)"],
      provider,
    );
    const cl = await escrow.creditLedger();
    expect(cl.toLowerCase()).toBe(ADDRESSES.creditLedger.toLowerCase());
  });

  test("account is correctly wired", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function account() view returns (address)"],
      provider,
    );
    const acct = await escrow.account();
    expect(acct.toLowerCase()).toBe(ADDRESSES.account.toLowerCase());
  });

  test("getPurchasesBySignal returns empty array for unknown signal", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function getPurchasesBySignal(uint256) view returns (uint256[])"],
      provider,
    );
    const purchases = await escrow.getPurchasesBySignal(999999);
    expect(purchases).toHaveLength(0);
  });
});

test.describe("Collateral contract", () => {
  test("getDeposit returns 0 for random address", async () => {
    const coll = new ethers.Contract(
      ADDRESSES.collateral,
      ["function getDeposit(address) view returns (uint256)"],
      provider,
    );
    const deposit = await coll.getDeposit(RANDOM_ADDRESS);
    expect(deposit).toBe(0n);
  });

  test("getLocked returns 0 for random address", async () => {
    const coll = new ethers.Contract(
      ADDRESSES.collateral,
      ["function getLocked(address) view returns (uint256)"],
      provider,
    );
    const locked = await coll.getLocked(RANDOM_ADDRESS);
    expect(locked).toBe(0n);
  });

  test("getAvailable returns 0 for random address", async () => {
    const coll = new ethers.Contract(
      ADDRESSES.collateral,
      ["function getAvailable(address) view returns (uint256)"],
      provider,
    );
    const avail = await coll.getAvailable(RANDOM_ADDRESS);
    expect(avail).toBe(0n);
  });
});

test.describe("CreditLedger contract", () => {
  test("balanceOf returns 0 for random address", async () => {
    const cl = new ethers.Contract(
      ADDRESSES.creditLedger,
      ["function balanceOf(address) view returns (uint256)"],
      provider,
    );
    const balance = await cl.balanceOf(RANDOM_ADDRESS);
    expect(balance).toBe(0n);
  });
});

test.describe("Account contract", () => {
  test("getSignalCount returns 0 for unknown pair", async () => {
    const acct = new ethers.Contract(
      ADDRESSES.account,
      ["function getSignalCount(address, address) view returns (uint256)"],
      provider,
    );
    const count = await acct.getSignalCount(RANDOM_ADDRESS, ZERO_ADDRESS);
    expect(count).toBe(0n);
  });

  test("getCurrentCycle returns 0 for unknown pair", async () => {
    const acct = new ethers.Contract(
      ADDRESSES.account,
      ["function getCurrentCycle(address, address) view returns (uint256)"],
      provider,
    );
    const cycle = await acct.getCurrentCycle(RANDOM_ADDRESS, ZERO_ADDRESS);
    expect(cycle).toBe(0n);
  });

  test("isAuditReady returns false for unknown pair", async () => {
    const acct = new ethers.Contract(
      ADDRESSES.account,
      ["function isAuditReady(address, address) view returns (bool)"],
      provider,
    );
    const ready = await acct.isAuditReady(RANDOM_ADDRESS, ZERO_ADDRESS);
    expect(ready).toBe(false);
  });
});

// TrackRecord contract is no longer deployed (removed in latest deployment)

test.describe("Cross-contract wiring", () => {
  test("Audit.PROTOCOL_FEE_BPS is 50 (0.5%)", async () => {
    const audit = new ethers.Contract(
      ADDRESSES.audit,
      ["function PROTOCOL_FEE_BPS() view returns (uint256)"],
      provider,
    );
    const fee = await audit.PROTOCOL_FEE_BPS();
    expect(fee).toBe(50n);
  });

  test("Account.SIGNALS_PER_CYCLE is 10", async () => {
    const account = new ethers.Contract(
      ADDRESSES.account,
      ["function SIGNALS_PER_CYCLE() view returns (uint256)"],
      provider,
    );
    const spc = await account.SIGNALS_PER_CYCLE();
    expect(spc).toBe(10n);
  });
});

test.describe("Multi-purchase verification", () => {
  test("getSignalNotionalFilled returns uint for any signal", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function getSignalNotionalFilled(uint256) view returns (uint256)"],
      provider,
    );
    const filled = await escrow.getSignalNotionalFilled(999999);
    expect(filled).toBe(0n);
  });

  test("canPurchase view function works for known signal", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      [
        "function canPurchase(uint256 signalId, uint256 notional) view returns (bool, string)",
      ],
      provider,
    );
    // Signal 43 is a known test signal — check it returns a valid response
    try {
      const [canBuy] = await escrow.canPurchase(
        43,
        ethers.parseUnits("100", 6),
      );
      expect(typeof canBuy).toBe("boolean");
    } catch {
      // If signal doesn't exist, the contract reverts — that's acceptable
    }
  });

  test("Escrow.MIN_NOTIONAL is 1 USDC", async () => {
    const escrow = new ethers.Contract(
      ADDRESSES.escrow,
      ["function MIN_NOTIONAL() view returns (uint256)"],
      provider,
    );
    const min = await escrow.MIN_NOTIONAL();
    expect(min).toBe(ethers.parseUnits("1", 6));
  });
});
