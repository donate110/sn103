import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock wagmi modules
const mockWriteContract = vi.fn();
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0xTestBuyer", isConnected: true }),
  useWalletClient: () => ({ data: { writeContract: mockWriteContract } }),
}));

// Mock @wagmi/core (waitForTransactionReceipt, getBlockNumber)
vi.mock("@wagmi/core", () => ({
  waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  getBlockNumber: vi.fn().mockResolvedValue(100n),
}));

// Mock viem
vi.mock("viem", () => ({
  parseAbi: (strs: string[]) => strs,
}));

// Mock app/providers
vi.mock("../../app/providers", () => ({
  wagmiConfig: {},
}));

// Mock contracts module
const mockBalanceOf = vi.fn();
const mockAllowance = vi.fn();
vi.mock("../contracts", () => ({
  getSignalCommitmentContract: () => ({}),
  getEscrowContract: () => ({}),
  getCollateralContract: () => ({}),
  getCreditLedgerContract: () => ({}),
  getUsdcContract: () => ({
    balanceOf: mockBalanceOf,
    allowance: mockAllowance,
  }),
  ADDRESSES: {
    signalCommitment: "0x1111111111111111111111111111111111111111",
    escrow: "0x2222222222222222222222222222222222222222",
    collateral: "0x3333333333333333333333333333333333333333",
    creditLedger: "0x4444444444444444444444444444444444444444",
    usdc: "0x5555555555555555555555555555555555555555",
    account: "0x6666666666666666666666666666666666666666",
  },
}));

// Mock read provider
const mockProvider = { getBlockNumber: vi.fn() };
vi.mock("../hooks", async () => {
  const actual = await vi.importActual("../hooks");
  return {
    ...(actual as Record<string, unknown>),
    useEthersProvider: () => mockProvider,
    getReadProvider: () => mockProvider,
  };
});

import { usePurchaseSignal, useDepositEscrow, useWithdrawEscrow } from "../hooks";

beforeEach(() => {
  vi.clearAllMocks();
  mockAllowance.mockResolvedValue(0n);
});

describe("usePurchaseSignal", () => {
  it("starts with clean state", () => {
    const { result } = renderHook(() => usePurchaseSignal());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBeNull();
    expect(typeof result.current.purchase).toBe("function");
  });

  it("calls writeContract with correct args and returns txHash", async () => {
    const fakeTxHash = "0xabc123def456";
    mockWriteContract.mockResolvedValueOnce(fakeTxHash);

    const { result } = renderHook(() => usePurchaseSignal());

    await act(async () => {
      const hash = await result.current.purchase(42n, 1000_000_000n, 1_910_000n);
      expect(hash).toBe(fakeTxHash);
    });

    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "purchase",
        args: [42n, 1000_000_000n, 1_910_000n],
      }),
    );
    expect(result.current.txHash).toBe(fakeTxHash);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets error on writeContract failure", async () => {
    mockWriteContract.mockRejectedValueOnce(
      new Error("User rejected the request"),
    );

    const { result } = renderHook(() => usePurchaseSignal());

    // purchase() re-throws, so catch it
    await act(async () => {
      try {
        await result.current.purchase(1n, 100n, 200n);
      } catch {
        // expected
      }
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.loading).toBe(false);
    expect(result.current.txHash).toBeNull();
  });

  it("clears error on subsequent purchase attempt", async () => {
    mockWriteContract
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("0xsecond-hash");

    const { result } = renderHook(() => usePurchaseSignal());

    // First attempt fails
    await act(async () => {
      try {
        await result.current.purchase(1n, 100n, 200n);
      } catch {
        // expected
      }
    });
    expect(result.current.error).toBeTruthy();

    // Second attempt succeeds
    await act(async () => {
      await result.current.purchase(2n, 200n, 300n);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.txHash).toBe("0xsecond-hash");
  });
});

describe("useDepositEscrow", () => {
  it("starts with clean state", () => {
    const { result } = renderHook(() => useDepositEscrow());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.deposit).toBe("function");
  });

  it("approves USDC on first call, deposits on second", async () => {
    // First call: allowance is 0, so approve only (returns "approved")
    mockBalanceOf.mockResolvedValueOnce(10_000_000_000n);
    mockAllowance.mockResolvedValueOnce(0n);
    mockWriteContract.mockResolvedValueOnce("0xapprove-hash");

    const { result } = renderHook(() => useDepositEscrow());

    await act(async () => {
      const hash = await result.current.deposit(1_000_000_000n);
      expect(hash).toBe("approved");
    });

    expect(mockWriteContract).toHaveBeenCalledTimes(1);
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "approve" }),
    );

    // Second call: allowance is now sufficient, so deposit happens
    mockBalanceOf.mockResolvedValueOnce(10_000_000_000n);
    mockAllowance.mockResolvedValueOnce(BigInt("0xffffffffffffffff"));
    mockWriteContract.mockResolvedValueOnce("0xdeposit-hash");

    await act(async () => {
      const hash = await result.current.deposit(1_000_000_000n);
      expect(hash).toBe("0xdeposit-hash");
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("fails if insufficient USDC balance", async () => {
    mockBalanceOf.mockResolvedValueOnce(100n);

    const { result } = renderHook(() => useDepositEscrow());

    await act(async () => {
      try {
        await result.current.deposit(1_000_000_000n);
      } catch {
        // expected - deposit() re-throws
      }
    });

    // Should not have called writeContract at all
    expect(mockWriteContract).not.toHaveBeenCalled();
    expect(result.current.error).toBeTruthy();
    expect(result.current.loading).toBe(false);
  });
});

describe("useWithdrawEscrow", () => {
  it("starts with clean state", () => {
    const { result } = renderHook(() => useWithdrawEscrow());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.withdraw).toBe("function");
  });

  it("calls writeContract with withdraw args", async () => {
    mockWriteContract.mockResolvedValueOnce("0xwithdraw-hash");

    const { result } = renderHook(() => useWithdrawEscrow());

    await act(async () => {
      const hash = await result.current.withdraw(500_000_000n);
      expect(hash).toBe("0xwithdraw-hash");
    });

    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "withdraw",
        args: [500_000_000n],
      }),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets error on withdraw failure", async () => {
    mockWriteContract.mockRejectedValueOnce(
      new Error("Insufficient balance"),
    );

    const { result } = renderHook(() => useWithdrawEscrow());

    await act(async () => {
      try {
        await result.current.withdraw(999_999_999_999n);
      } catch {
        // expected - withdraw() re-throws
      }
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.loading).toBe(false);
  });
});
