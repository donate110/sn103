"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useChainId, useBalance, useReadContract } from "wagmi";
import { parseAbi, formatUnits } from "viem";
import Link from "next/link";
import { ADDRESSES } from "@/lib/contracts";

const USDC_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const ESCROW_ABI = parseAbi([
  "function balances(address) view returns (uint256)",
]);

const COLLATERAL_ABI = parseAbi([
  "function deposits(address) view returns (uint256)",
]);

// Base mainnet = 8453, Base Sepolia = 84532
const EXPECTED_CHAINS = [8453, 84532];

const COLLAPSED_KEY = "djinn_onboarding_collapsed";

// Custom event name for triggering onboarding refresh from anywhere
export const ONBOARDING_REFRESH_EVENT = "djinn:onboarding-refresh";

/** Call this after any successful transaction to refresh the onboarding checklist */
export function triggerOnboardingRefresh() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ONBOARDING_REFRESH_EVENT));
  }
}

interface CheckItemProps {
  done: boolean;
  loading?: boolean;
  label: string;
  hint?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

function CheckItem({ done, loading, label, hint, action }: CheckItemProps) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 flex-shrink-0">
        {loading ? (
          <div className="w-5 h-5 rounded-full border-2 border-slate-200 border-t-blue-500 animate-spin" />
        ) : done ? (
          <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
            <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        ) : (
          <div className="w-5 h-5 rounded-full border-2 border-slate-200" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${done ? "text-green-600" : "text-slate-900"}`}>
          {done ? `\u2713 ${label}` : label}
        </p>
        {!done && hint && (
          <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
        )}
        {!done && action && (
          action.href ? (
            <Link
              href={action.href}
              target={action.href.startsWith("http") ? "_blank" : undefined}
              rel={action.href.startsWith("http") ? "noopener noreferrer" : undefined}
              className="inline-block mt-1 text-xs font-medium text-blue-600 hover:text-blue-500"
            >
              {action.label} &rarr;
            </Link>
          ) : action.onClick ? (
            <button
              onClick={action.onClick}
              className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-500"
            >
              {action.label} &rarr;
            </button>
          ) : null
        )}
      </div>
    </div>
  );
}

interface OnboardingChecklistProps {
  role: "genius" | "idiot";
  /** Where to render: "top" shows in-progress only, "bottom" shows complete only */
  position?: "top" | "bottom";
}

export default function OnboardingChecklist({ role, position = "top" }: OnboardingChecklistProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [collapsed, setCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Persist collapsed state
  useEffect(() => {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    if (stored === "true") setCollapsed(true);
  }, []);

  // Listen for refresh events from transaction success handlers
  useEffect(() => {
    function handleRefresh() {
      setRefreshKey((k) => k + 1);
    }
    window.addEventListener(ONBOARDING_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(ONBOARDING_REFRESH_EVENT, handleRefresh);
  }, []);

  // Also auto-refresh every 10 seconds while incomplete
  useEffect(() => {
    const timer = setInterval(() => {
      setRefreshKey((k) => k + 1);
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, String(next));
  }

  const onCorrectChain = EXPECTED_CHAINS.includes(chainId);

  // ETH balance for gas
  const { data: ethBalance, isLoading: ethLoading, refetch: refetchEth } = useBalance({
    address,
    query: { enabled: isConnected },
  });
  const hasGasEth = ethBalance ? ethBalance.value > 0n : false;

  // USDC balance
  const usdcAddress = ADDRESSES.usdc as `0x${string}`;
  const { data: usdcBalance, isLoading: usdcLoading, refetch: refetchUsdc } = useReadContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && !!address },
  });
  const usdcAmount = usdcBalance ? Number(formatUnits(usdcBalance, 6)) : 0;
  const hasUsdc = usdcAmount >= 1;

  // Deposit check
  const depositAddress = (role === "genius" ? ADDRESSES.collateral : ADDRESSES.escrow) as `0x${string}`;
  const depositAbi = role === "genius" ? COLLATERAL_ABI : ESCROW_ABI;
  const depositFn = role === "genius" ? "deposits" : "balances";
  const { data: depositBalance, isLoading: depositLoading, refetch: refetchDeposit } = useReadContract({
    address: depositAddress,
    abi: depositAbi,
    functionName: depositFn,
    args: address ? [address] : undefined,
    query: { enabled: isConnected && !!address && depositAddress !== "0x0000000000000000000000000000000000000000" },
  });
  const depositAmount = depositBalance ? Number(formatUnits(depositBalance as bigint, 6)) : 0;
  const hasDeposit = depositAmount >= 1;

  // Refetch all on refreshKey change
  useEffect(() => {
    if (refreshKey > 0 && isConnected) {
      refetchEth();
      refetchUsdc();
      refetchDeposit();
    }
  }, [refreshKey, isConnected, refetchEth, refetchUsdc, refetchDeposit]);

  const checksReal = [isConnected, onCorrectChain, hasUsdc, hasDeposit];
  const completed = checksReal.filter(Boolean).length;
  const total = checksReal.length;
  const allDone = completed === total;

  // Don't show if wallet not connected
  if (!isConnected) return null;

  const depositLabel = role === "genius" ? "collateral" : "escrow";

  // Position logic: top shows in-progress, bottom shows complete
  if (position === "top" && allDone) return null;
  if (position === "bottom" && !allDone) return null;

  // All done: show compact celebration
  if (allDone) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 mb-6 overflow-hidden">
        <button
          onClick={toggleCollapsed}
          className="w-full flex items-center justify-between px-5 py-3 hover:bg-green-100/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="font-semibold text-green-800 text-sm">Onboarding complete!</h3>
          </div>
          <svg
            className={`w-4 h-4 text-green-400 transition-transform ${collapsed ? "" : "rotate-180"}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {!collapsed && (
          <div className="px-5 pb-4 border-t border-green-200">
            <div className="divide-y divide-green-100">
              <CheckItem done label="Connect wallet" />
              <CheckItem done label="Base network" />
              <CheckItem done label="USDC on Base" />
              <CheckItem done label={`Deposited to ${depositLabel}`} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white mb-6 overflow-hidden">
      {/* Header (always visible, clickable to toggle) */}
      <button
        onClick={toggleCollapsed}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <h3 className="font-semibold text-slate-900 text-sm">Getting started</h3>
          <span className="text-xs text-slate-400">
            {completed}/{total} complete
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Mini progress bar */}
          <div className="w-16 h-1.5 bg-slate-100 rounded-full">
            <div
              className="h-1.5 bg-blue-500 rounded-full transition-all duration-500"
              style={{ width: `${(completed / total) * 100}%` }}
            />
          </div>
          <svg
            className={`w-4 h-4 text-slate-400 transition-transform ${collapsed ? "" : "rotate-180"}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Collapsible body */}
      {!collapsed && (
        <div className="px-5 pb-4 border-t border-slate-100">
          {/* Safety tip */}
          <div className="rounded-lg bg-amber-50 border border-amber-100 px-3 py-2 my-3">
            <p className="text-xs text-amber-800">
              <strong>Safety tip:</strong> Only deposit what you can afford to lose.
              Smart contracts carry inherent risk. Start small to learn how everything
              works before committing larger amounts.
            </p>
          </div>

          <div className="divide-y divide-slate-100">
            <CheckItem
              done={isConnected}
              label="Connect wallet"
              hint="Your wallet is how you sign transactions and prove your identity. We recommend Coinbase Smart Wallet: it's free to create, has no gas fees on Base, and works with just an email. You can also use MetaMask or any WalletConnect wallet."
            />
            <CheckItem
              done={onCorrectChain}
              label="Switch to Base network"
              hint="Djinn's smart contracts live on Base, a fast and cheap Ethereum Layer 2 built by Coinbase. Your wallet should prompt you to switch automatically. If not, you can add Base manually (Chain ID: 8453)."
            />
            <CheckItem
              done={hasUsdc}
              loading={usdcLoading}
              label={`Get USDC on Base${hasUsdc ? "" : ` (you have $${usdcAmount.toFixed(2)})`}`}
              hint="USDC is a stablecoin worth $1. Djinn uses it for all payments and deposits so your balance doesn't fluctuate with crypto prices. Buy USDC directly in Coinbase Wallet with a debit card, or bridge USDC from another chain. Start with a small amount ($10-50) while you learn."
              action={{
                label: "Get USDC on Coinbase",
                href: "https://www.coinbase.com/how-to-buy/usd-coin",
              }}
            />
            <CheckItem
              done={hasDeposit}
              loading={depositLoading}
              label={`Deposit USDC to ${depositLabel}${hasDeposit ? "" : ` ($${depositAmount.toFixed(2)} deposited)`}`}
              hint={
                role === "genius"
                  ? "Collateral is your \"skin in the game.\" It backs your predictions: if you underperform, your collateral is slashed to compensate buyers. Use the deposit form below. The first time, your wallet will ask you to approve USDC spending (a one-time permission), then confirm the deposit."
                  : "Your escrow balance is what you use to buy signals. When you purchase a signal, the fee comes from this balance. Use the deposit form below. The first time, your wallet will ask you to approve USDC spending (a one-time permission), then confirm the deposit."
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
