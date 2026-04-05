import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SignalCard from "../SignalCard";
import { type Signal, SignalStatus } from "@/lib/types";

// Mock next/link to render a plain anchor tag for testing
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function createMockSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    genius: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    encryptedBlob: "0xencrypted",
    commitHash: "0xcommithash",
    sport: "NFL",
    maxPriceBps: 500n,
    slaMultiplierBps: 200n,
    maxNotional: 10000_000000n,
    minNotional: 0n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400), // 1 day from now
    decoyLines: ["Line A over 3.5", "Line B under 7"],
    availableSportsbooks: ["DraftKings", "FanDuel"],
    status: SignalStatus.Active,
    createdAt: BigInt(Math.floor(Date.now() / 1000)),
    linesHash: "0x" + "0".repeat(64),
    lineCount: 0,
    bpaMode: false,
    ...overrides,
  };
}

describe("SignalCard", () => {
  describe("renders signal data correctly", () => {
    it("displays the signal ID", () => {
      render(<SignalCard signalId="42" signal={createMockSignal()} />);
      expect(screen.getByText("Signal #42")).toBeInTheDocument();
    });

    it("displays the genius address (truncated)", () => {
      render(<SignalCard signalId="1" signal={createMockSignal()} />);
      expect(screen.getByText("by 0xAbCd...Ef01")).toBeInTheDocument();
    });

    it("displays the sport", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ sport: "NBA" })}
        />
      );
      expect(screen.getByText("NBA")).toBeInTheDocument();
    });

    it("displays the max price in percentage", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ maxPriceBps: 500n })}
        />
      );
      expect(screen.getByText("5%")).toBeInTheDocument();
    });

    it("displays the SLA multiplier in percentage", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ slaMultiplierBps: 200n })}
        />
      );
      expect(screen.getByText("2%")).toBeInTheDocument();
    });

    it("displays the expiration date", () => {
      const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400);
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ expiresAt: futureTs })}
        />
      );
      const expectedDate = new Date(Number(futureTs) * 1000).toLocaleDateString();
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });

    it("displays line count summary for v1 signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            decoyLines: ["Over 3.5", "Under 7"],
          })}
        />
      );
      expect(screen.getByText("2 lines")).toBeInTheDocument();
    });

    it("displays line count summary for v2 signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            decoyLines: [],
            lineCount: 1000,
            linesHash: "0x" + "ab".repeat(32),
          })}
        />
      );
      expect(screen.getByText("1000 lines (privacy-enhanced)")).toBeInTheDocument();
    });

    it("hides lines section when both decoyLines and lineCount are empty/zero", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ decoyLines: [], lineCount: 0 })}
        />
      );
      expect(screen.queryByText(/lines/i)).not.toBeInTheDocument();
    });

    it("displays available sportsbooks when present", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            availableSportsbooks: ["DraftKings", "FanDuel"],
          })}
        />
      );
      expect(screen.getByText("DraftKings")).toBeInTheDocument();
      expect(screen.getByText("FanDuel")).toBeInTheDocument();
    });

    it("hides sportsbooks section when array is empty", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ availableSportsbooks: [] })}
        />
      );
      expect(screen.queryByText("DraftKings")).not.toBeInTheDocument();
    });
  });

  describe("status badges", () => {
    it("shows 'Active' badge for active signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Active })}
        />
      );
      expect(screen.getByText("Active")).toBeInTheDocument();
    });

    it("shows 'Cancelled' badge for cancelled signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Cancelled })}
        />
      );
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
    });

    it("shows 'Settled' badge for settled signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Settled })}
        />
      );
      expect(screen.getByText("Settled")).toBeInTheDocument();
    });

    it("applies green styling for Active status", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Active })}
        />
      );
      const badge = screen.getByText("Active");
      expect(badge.className).toContain("text-green-600");
      expect(badge.className).toContain("bg-green-100");
    });

    it("applies slate styling for Settled status", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Settled })}
        />
      );
      const badge = screen.getByText("Settled");
      expect(badge.className).toContain("text-slate-500");
      expect(badge.className).toContain("bg-slate-100");
    });

    it("applies red styling for Cancelled status", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Cancelled })}
        />
      );
      const badge = screen.getByText("Cancelled");
      expect(badge.className).toContain("text-red-600");
      expect(badge.className).toContain("bg-red-100");
    });
  });

  describe("purchase link", () => {
    it("shows Purchase Signal link for active, non-expired signals when showPurchaseLink=true", () => {
      render(
        <SignalCard
          signalId="42"
          signal={createMockSignal({ status: SignalStatus.Active })}
          showPurchaseLink
        />
      );
      const link = screen.getByText("Purchase Signal");
      expect(link).toBeInTheDocument();
      expect(link.closest("a")).toHaveAttribute("href", "/idiot/signal/42");
    });

    it("does not show purchase link by default", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Active })}
        />
      );
      expect(screen.queryByText("Purchase Signal")).not.toBeInTheDocument();
    });

    it("does not show purchase link for non-active signals", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ status: SignalStatus.Cancelled })}
          showPurchaseLink
        />
      );
      expect(screen.queryByText("Purchase Signal")).not.toBeInTheDocument();
    });

    it("does not show purchase link for expired signals", () => {
      const pastTs = BigInt(Math.floor(Date.now() / 1000) - 86400); // 1 day ago
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            status: SignalStatus.Active,
            expiresAt: pastTs,
          })}
          showPurchaseLink
        />
      );
      expect(screen.queryByText("Purchase Signal")).not.toBeInTheDocument();
    });
  });

  describe("expiration styling", () => {
    it("applies red text to expired dates", () => {
      const pastTs = BigInt(Math.floor(Date.now() / 1000) - 86400);
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ expiresAt: pastTs })}
        />
      );
      const dateStr = new Date(Number(pastTs) * 1000).toLocaleDateString();
      const dateEl = screen.getByText(dateStr);
      expect(dateEl.className).toContain("text-red-600");
    });

    it("applies slate text to future dates", () => {
      const futureTs = BigInt(Math.floor(Date.now() / 1000) + 86400);
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({ expiresAt: futureTs })}
        />
      );
      const dateStr = new Date(Number(futureTs) * 1000).toLocaleDateString();
      const dateEl = screen.getByText(dateStr);
      expect(dateEl.className).toContain("text-slate-900");
    });
  });

  describe("grid labels", () => {
    it("renders all four data labels", () => {
      render(<SignalCard signalId="1" signal={createMockSignal()} />);
      expect(screen.getByText("Sport")).toBeInTheDocument();
      expect(screen.getByText("Max Price")).toBeInTheDocument();
      expect(screen.getByText("SLA Multiplier")).toBeInTheDocument();
      expect(screen.getByText("Expires")).toBeInTheDocument();
    });
  });

  describe("exclusive badge", () => {
    it("shows Exclusive badge when minNotional equals maxNotional", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            maxNotional: 500_000000n,
            minNotional: 500_000000n,
          })}
        />,
      );
      expect(screen.getByText("Exclusive")).toBeInTheDocument();
    });

    it("does not show Exclusive badge when minNotional is zero", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            maxNotional: 500_000000n,
            minNotional: 0n,
          })}
        />,
      );
      expect(screen.queryByText("Exclusive")).not.toBeInTheDocument();
    });

    it("does not show Exclusive badge when minNotional differs from maxNotional", () => {
      render(
        <SignalCard
          signalId="1"
          signal={createMockSignal({
            maxNotional: 500_000000n,
            minNotional: 100_000000n,
          })}
        />,
      );
      expect(screen.queryByText("Exclusive")).not.toBeInTheDocument();
    });
  });
});
