import { describe, it, expect } from "vitest";
import {
  ADDRESSES,
  SIGNAL_COMMITMENT_ABI,
  ESCROW_ABI,
  COLLATERAL_ABI,
  CREDIT_LEDGER_ABI,
  ACCOUNT_ABI,
  ERC20_ABI,
  getSignalCommitmentContract,
  getEscrowContract,
  getCollateralContract,
  getCreditLedgerContract,
  getAccountContract,
  getUsdcContract,
  safeAddress,
} from "../contracts";

describe("ADDRESSES", () => {
  it("has all required contract addresses as strings", () => {
    expect(typeof ADDRESSES.signalCommitment).toBe("string");
    expect(typeof ADDRESSES.escrow).toBe("string");
    expect(typeof ADDRESSES.collateral).toBe("string");
    expect(typeof ADDRESSES.creditLedger).toBe("string");
    expect(typeof ADDRESSES.account).toBe("string");
    expect(typeof ADDRESSES.usdc).toBe("string");
    expect(typeof ADDRESSES.audit).toBe("string");
  });

  it("has valid Ethereum address format (0x prefixed, 42 chars)", () => {
    const addressRegex = /^0x[0-9a-fA-F]{40}$/;
    for (const [key, addr] of Object.entries(ADDRESSES)) {
      expect(addr, `ADDRESSES.${key} should be a valid Ethereum address`).toMatch(addressRegex);
    }
  });

  it("has the correct default USDC address for Base", () => {
    expect(ADDRESSES.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

describe("ABI definitions", () => {
  it("SIGNAL_COMMITMENT_ABI is a non-empty array", () => {
    expect(Array.isArray(SIGNAL_COMMITMENT_ABI)).toBe(true);
    expect(SIGNAL_COMMITMENT_ABI.length).toBeGreaterThan(0);
  });

  it("ESCROW_ABI is a non-empty array", () => {
    expect(Array.isArray(ESCROW_ABI)).toBe(true);
    expect(ESCROW_ABI.length).toBeGreaterThan(0);
  });

  it("COLLATERAL_ABI is a non-empty array", () => {
    expect(Array.isArray(COLLATERAL_ABI)).toBe(true);
    expect(COLLATERAL_ABI.length).toBeGreaterThan(0);
  });

  it("CREDIT_LEDGER_ABI is a non-empty array", () => {
    expect(Array.isArray(CREDIT_LEDGER_ABI)).toBe(true);
    expect(CREDIT_LEDGER_ABI.length).toBeGreaterThan(0);
  });

  it("ACCOUNT_ABI is a non-empty array", () => {
    expect(Array.isArray(ACCOUNT_ABI)).toBe(true);
    expect(ACCOUNT_ABI.length).toBeGreaterThan(0);
  });

  it("ERC20_ABI is a non-empty array", () => {
    expect(Array.isArray(ERC20_ABI)).toBe(true);
    expect(ERC20_ABI.length).toBeGreaterThan(0);
  });

  it("SIGNAL_COMMITMENT_ABI contains expected function signatures", () => {
    const abiStr = SIGNAL_COMMITMENT_ABI.join("\n");
    expect(abiStr).toContain("commit");
    expect(abiStr).toContain("getSignal");
    expect(abiStr).toContain("cancelSignal");
    expect(abiStr).toContain("isActive");
    expect(abiStr).toContain("signalExists");
  });

  it("ESCROW_ABI contains expected function signatures", () => {
    const abiStr = ESCROW_ABI.join("\n");
    expect(abiStr).toContain("deposit");
    expect(abiStr).toContain("withdraw");
    expect(abiStr).toContain("purchase");
    expect(abiStr).toContain("getBalance");
    expect(abiStr).toContain("getPurchase");
  });

  it("COLLATERAL_ABI contains expected function signatures", () => {
    const abiStr = COLLATERAL_ABI.join("\n");
    expect(abiStr).toContain("deposit");
    expect(abiStr).toContain("withdraw");
    expect(abiStr).toContain("getDeposit");
    expect(abiStr).toContain("getLocked");
    expect(abiStr).toContain("getAvailable");
  });

  it("ERC20_ABI contains standard ERC20 functions", () => {
    const abiStr = ERC20_ABI.join("\n");
    expect(abiStr).toContain("approve");
    expect(abiStr).toContain("allowance");
    expect(abiStr).toContain("balanceOf");
    expect(abiStr).toContain("decimals");
  });
});

describe("safeAddress", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";

  it("returns zero address as-is", () => {
    expect(safeAddress(ZERO, ZERO)).toBe(ZERO);
  });

  it("checksums a valid lowercase address", () => {
    const lower = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const result = safeAddress(lower, ZERO);
    expect(result).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("returns fallback when raw is undefined", () => {
    expect(safeAddress(undefined, ZERO)).toBe(ZERO);
  });

  it("falls back to zero for garbage input", () => {
    expect(safeAddress("not-an-address", ZERO)).toBe(ZERO);
  });

  it("falls back to zero for too-short address", () => {
    expect(safeAddress("0x1234", ZERO)).toBe(ZERO);
  });

  it("passes through already-checksummed address", () => {
    const checksummed = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    expect(safeAddress(checksummed, ZERO)).toBe(checksummed);
  });
});

describe("Contract factory functions", () => {
  it("getSignalCommitmentContract is a function", () => {
    expect(typeof getSignalCommitmentContract).toBe("function");
  });

  it("getEscrowContract is a function", () => {
    expect(typeof getEscrowContract).toBe("function");
  });

  it("getCollateralContract is a function", () => {
    expect(typeof getCollateralContract).toBe("function");
  });

  it("getCreditLedgerContract is a function", () => {
    expect(typeof getCreditLedgerContract).toBe("function");
  });

  it("getAccountContract is a function", () => {
    expect(typeof getAccountContract).toBe("function");
  });

  it("getUsdcContract is a function", () => {
    expect(typeof getUsdcContract).toBe("function");
  });
});
