"use client";

import { useState, useEffect } from "react";
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
        <p className={`text-sm font-medium ${done ? "text-slate-400 line-through" : "text-slate-900"}`}>
          {label}
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
}

export default function OnboardingChecklist({ role }: OnboardingChecklistProps) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [collapsed, setCollapsed] = useState(false);

  // Persist collapsed state
  useEffect(() => {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    if (stored === "true") setCollapsed(true);
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, String(next));
  }

  const onCorrectChain = EXPECTED_CHAINS.includes(chainId);

  // ETH balance for gas
  const { data: ethBalance, isLoading: ethLoading } = useBalance({
    address,
    query: { enabled: isConnected },
  });
  const hasGasEth = ethBalance ? ethBalance.value > 0n : false;

  // USDC balance
  const usdcAddress = ADDRESSES.usdc as `0x${string}`;
  const { data: usdcBalance, isLoading: usdcLoading } = useReadContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: isConnected && !!address },
  });
  const usdcAmount = usdcBalance ? Number(formatUnits(usdcBalance, 6)) : 0;
  const hasUsdc = usdcAmount >= 1;

  // Combined: check both approval AND deposit together
  // The deposit UI handles approval automatically, so we just check the deposit balance
  const depositAddress = (role === "genius" ? ADDRESSES.collateral : ADDRESSES.escrow) as `0x${string}`;
  const depositAbi = role === "genius" ? COLLATERAL_ABI : ESCROW_ABI;
  const depositFn = role === "genius" ? "deposits" : "balances";
  const { data: depositBalance, isLoading: depositLoading } = useReadContract({
    address: depositAddress,
    abi: depositAbi,
    functionName: depositFn,
    args: address ? [address] : undefined,
    query: { enabled: isConnected && !!address && depositAddress !== "0x0000000000000000000000000000000000000000" },
  });
  const depositAmount = depositBalance ? Number(formatUnits(depositBalance as bigint, 6)) : 0;
  const hasDeposit = depositAmount >= 1;

  // 4 steps (merged approve+deposit into one)
  const checks = [isConnected, onCorrectChain, hasGasEth || true, hasUsdc, hasDeposit];
  // Note: hasGasEth is always true for now since Coinbase Smart Wallet has free gas.
  // We still show the step but mark it done with a note.
  const gasStepDone = hasGasEth;
  const checksReal = [isConnected, onCorrectChain, hasUsdc, hasDeposit];
  const completed = checksReal.filter(Boolean).length;
  const total = checksReal.length;

  // Don't show if all done
  if (completed === total) return null;
  // Don't show if wallet not connected
  if (!isConnected) return null;

  const depositLabel = role === "genius" ? "collateral" : "escrow";
  const depositHint = role === "genius"
    ? "Use the deposit form below. Collateral backs your signals. The first deposit will prompt a USDC approval, then the deposit."
    : "Use the deposit form below. Your escrow balance is used to purchase signals. The first deposit will prompt a USDC approval, then the deposit.";

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
          <div className="divide-y divide-slate-100">
            <CheckItem
              done={isConnected}
              label="Connect wallet"
              hint="Use Coinbase Smart Wallet (recommended, free gas) or any WalletConnect wallet."
            />
            <CheckItem
              done={onCorrectChain}
              label="Switch to Base network"
              hint="Djinn runs on Base (Coinbase L2). Your wallet should prompt you to switch."
            />
            <CheckItem
              done={hasUsdc}
              loading={usdcLoading}
              label={`Get USDC on Base${hasUsdc ? "" : ` (you have $${usdcAmount.toFixed(2)})`}`}
              hint="Buy USDC directly in Coinbase Wallet, or bridge from Ethereum. Gas fees on Base are under $0.01."
              action={{
                label: "Get USDC on Coinbase",
                href: "https://www.coinbase.com/how-to-buy/usd-coin",
              }}
            />
            <CheckItem
              done={hasDeposit}
              loading={depositLoading}
              label={`Deposit USDC to ${depositLabel}${hasDeposit ? "" : ` ($${depositAmount.toFixed(2)} deposited)`}`}
              hint={depositHint}
            />
          </div>
        </div>
      )}
    </div>
  );
}
