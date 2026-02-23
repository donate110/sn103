import { describe, it, expect, vi, beforeEach } from "vitest";

// Current time in seconds (for expiry checks)
const NOW_SEC = Math.floor(Date.now() / 1000);
const FUTURE = NOW_SEC + 3600;
const PAST = NOW_SEC - 3600;

// Create shared mock state
const mockQueryFilter = vi.fn();
const mockFilters = {
  SignalCommitted: vi.fn(() => "signal-filter"),
  SignalPurchased: vi.fn(() => "purchase-filter"),
  AuditSettled: vi.fn(() => "audit-filter"),
  EarlyExitSettled: vi.fn(() => "early-exit-filter"),
};

// Use a regular function (not arrow) so it works with `new`
const mockIsActive = vi.fn().mockResolvedValue(true);
const mockGetSignal = vi.fn().mockResolvedValue({ minNotional: BigInt(0) });
function MockContract() {
  return { filters: mockFilters, queryFilter: mockQueryFilter, isActive: mockIsActive, getSignal: mockGetSignal };
}

vi.mock("ethers", () => ({
  ethers: {
    Contract: MockContract,
  },
}));

// Import after mock is set up
import {
  getActiveSignals,
  getSignalsByGenius,
  getPurchasesByBuyer,
  getAuditsByGenius,
  getAuditsByIdiot,
  resetEventCaches,
} from "../events";

const mockProvider = {} as any;

describe("getActiveSignals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventCaches();
  });

  it("returns signals with future expiry", async () => {
    mockQueryFilter.mockResolvedValue([
      {
        args: {
          signalId: BigInt(1),
          genius: "0xGenius",
          sport: "basketball_nba",
          maxPriceBps: BigInt(500),
          slaMultiplierBps: BigInt(200),
          maxNotional: BigInt(10000000000),
          expiresAt: BigInt(FUTURE),
        },
        blockNumber: 100,
      },
    ]);

    const signals = await getActiveSignals(mockProvider);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalId).toBe("1");
    expect(signals[0].genius).toBe("0xGenius");
    expect(signals[0].sport).toBe("basketball_nba");
    expect(signals[0].maxPriceBps).toBe(BigInt(500));
  });

  it("filters out expired signals", async () => {
    mockQueryFilter.mockResolvedValue([
      {
        args: {
          signalId: BigInt(1),
          genius: "0xGenius",
          sport: "basketball_nba",
          maxPriceBps: BigInt(500),
          slaMultiplierBps: BigInt(200),
          maxNotional: BigInt(10000000000),
          expiresAt: BigInt(PAST),
        },
        blockNumber: 50,
      },
      {
        args: {
          signalId: BigInt(2),
          genius: "0xGenius2",
          sport: "football_nfl",
          maxPriceBps: BigInt(300),
          slaMultiplierBps: BigInt(150),
          maxNotional: BigInt(5000000000),
          expiresAt: BigInt(FUTURE),
        },
        blockNumber: 100,
      },
    ]);

    const signals = await getActiveSignals(mockProvider);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalId).toBe("2");
  });

  it("skips events without args", async () => {
    mockQueryFilter.mockResolvedValue([{ blockNumber: 1 }]);

    const signals = await getActiveSignals(mockProvider);
    expect(signals).toHaveLength(0);
  });

  it("returns empty array when no events", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const signals = await getActiveSignals(mockProvider);
    expect(signals).toHaveLength(0);
  });
});

describe("getSignalsByGenius", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventCaches();
  });

  it("filters by genius address and future expiry", async () => {
    mockQueryFilter.mockResolvedValue([
      {
        args: {
          signalId: BigInt(5),
          genius: "0xGenius",
          sport: "hockey_nhl",
          maxPriceBps: BigInt(400),
          slaMultiplierBps: BigInt(100),
          maxNotional: BigInt(10000000000),
          expiresAt: BigInt(FUTURE),
        },
        blockNumber: 200,
      },
    ]);

    const signals = await getSignalsByGenius(mockProvider, "0xGenius");
    expect(signals).toHaveLength(1);
    expect(signals[0].signalId).toBe("5");
    expect(mockFilters.SignalCommitted).toHaveBeenCalledWith(null, "0xGenius");
  });
});

describe("getPurchasesByBuyer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventCaches();
  });

  it("returns purchase events", async () => {
    mockQueryFilter.mockResolvedValue([
      {
        args: {
          purchaseId: BigInt(10),
          signalId: BigInt(1),
          buyer: "0xBuyer",
          notional: BigInt(1000000),
          feePaid: BigInt(5000),
          creditUsed: BigInt(0),
          usdcPaid: BigInt(1005000),
        },
        blockNumber: 300,
      },
    ]);

    const purchases = await getPurchasesByBuyer(mockProvider, "0xBuyer");
    expect(purchases).toHaveLength(1);
    expect(purchases[0].signalId).toBe("1");
    expect(purchases[0].notional).toBe(BigInt(1000000));
    expect(purchases[0].feePaid).toBe(BigInt(5000));
    expect(mockFilters.SignalPurchased).toHaveBeenCalledWith(null, "0xBuyer");
  });

  it("returns empty for no events", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const purchases = await getPurchasesByBuyer(mockProvider, "0xBuyer");
    expect(purchases).toHaveLength(0);
  });
});

describe("getAuditsByGenius", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventCaches();
  });

  it("combines audit and early exit events", async () => {
    // First call: AuditSettled
    mockQueryFilter
      .mockResolvedValueOnce([
        {
          args: {
            genius: "0xGenius",
            idiot: "0xIdiot1",
            cycle: BigInt(1),
            qualityScore: BigInt(850),
            trancheA: BigInt(100),
            trancheB: BigInt(200),
            protocolFee: BigInt(10),
          },
          blockNumber: 400,
        },
      ])
      // Second call: EarlyExitSettled
      .mockResolvedValueOnce([
        {
          args: {
            genius: "0xGenius",
            idiot: "0xIdiot2",
            cycle: BigInt(2),
            qualityScore: BigInt(600),
            creditsAwarded: BigInt(50),
          },
          blockNumber: 500,
        },
      ]);

    const audits = await getAuditsByGenius(mockProvider, "0xGenius");
    expect(audits).toHaveLength(2);

    // Sorted by blockNumber descending
    expect(audits[0].blockNumber).toBe(500);
    expect(audits[0].isEarlyExit).toBe(true);
    expect(audits[0].trancheA).toBe(0n);
    expect(audits[0].trancheB).toBe(BigInt(50));

    expect(audits[1].blockNumber).toBe(400);
    expect(audits[1].isEarlyExit).toBe(false);
    expect(audits[1].qualityScore).toBe(BigInt(850));
  });

  it("returns empty when no audits exist", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const audits = await getAuditsByGenius(mockProvider, "0xGenius");
    expect(audits).toHaveLength(0);
  });
});

describe("getAuditsByIdiot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEventCaches();
  });

  it("queries by idiot address and combines events", async () => {
    mockQueryFilter
      .mockResolvedValueOnce([
        {
          args: {
            genius: "0xGenius1",
            idiot: "0xIdiot",
            cycle: BigInt(1),
            qualityScore: BigInt(700),
            trancheA: BigInt(50),
            trancheB: BigInt(100),
            protocolFee: BigInt(5),
          },
          blockNumber: 600,
        },
      ])
      .mockResolvedValueOnce([
        {
          args: {
            genius: "0xGenius2",
            idiot: "0xIdiot",
            cycle: BigInt(1),
            qualityScore: BigInt(400),
            creditsAwarded: BigInt(25),
          },
          blockNumber: 700,
        },
      ]);

    const audits = await getAuditsByIdiot(mockProvider, "0xIdiot");
    expect(audits).toHaveLength(2);
    expect(audits[0].blockNumber).toBe(700);
    expect(audits[0].isEarlyExit).toBe(true);
    expect(audits[1].blockNumber).toBe(600);
    expect(audits[1].isEarlyExit).toBe(false);
    expect(audits[1].trancheA).toBe(BigInt(50));
    expect(mockFilters.AuditSettled).toHaveBeenCalledWith(null, "0xIdiot");
    expect(mockFilters.EarlyExitSettled).toHaveBeenCalledWith(null, "0xIdiot");
  });

  it("returns empty when no audits exist", async () => {
    mockQueryFilter.mockResolvedValue([]);

    const audits = await getAuditsByIdiot(mockProvider, "0xIdiot");
    expect(audits).toHaveLength(0);
  });
});
