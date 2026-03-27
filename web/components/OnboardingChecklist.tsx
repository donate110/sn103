"use client";

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
  const hasUsdc = usdcAmount >= 1; // at least $1

  // USDC allowance for the relevant contract
  const spenderAddress = (role === "genius" ? ADDRESSES.collateral : ADDRESSES.escrow) as `0x${string}`;
  const { data: allowance, isLoading: allowanceLoading } = useReadContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address && spenderAddress ? [address, spenderAddress] : undefined,
    query: { enabled: isConnected && !!address && spenderAddress !== "0x0000000000000000000000000000000000000000" },
  });
  const hasApproval = allowance ? allowance > 0n : false;

  // Deposit check
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

  // Count completed steps
  const checks = [isConnected, onCorrectChain, hasGasEth, hasUsdc, hasApproval, hasDeposit];
  const completed = checks.filter(Boolean).length;
  const total = checks.length;

  // Don't show if all done
  if (completed === total) return null;

  // Don't show if wallet not connected (the connect button handles that)
  if (!isConnected) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-slate-900 text-sm">Getting started</h3>
        <span className="text-xs text-slate-400">
          {completed}/{total} complete
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 bg-slate-100 rounded-full mb-4">
        <div
          className="h-1.5 bg-blue-500 rounded-full transition-all duration-500"
          style={{ width: `${(completed / total) * 100}%` }}
        />
      </div>

      <div className="divide-y divide-slate-100">
        <CheckItem
          done={isConnected}
          label="Connect wallet"
          hint="Use Coinbase Smart Wallet (recommended) or any WalletConnect wallet."
        />
        <CheckItem
          done={onCorrectChain}
          label="Switch to Base network"
          hint="Djinn runs on Base (Coinbase L2). Your wallet should prompt you to switch."
        />
        <CheckItem
          done={hasGasEth}
          loading={ethLoading}
          label="Get ETH for gas"
          hint="You need a tiny amount of ETH on Base for transaction fees (under $0.01 per tx). Coinbase Smart Wallet users: gas is free."
          action={{
            label: "Bridge ETH to Base",
            href: "https://bridge.base.org",
          }}
        />
        <CheckItem
          done={hasUsdc}
          loading={usdcLoading}
          label={`Get USDC on Base (you have $${usdcAmount.toFixed(2)})`}
          hint="You need USDC on Base to deposit. Buy USDC directly in Coinbase Wallet, or bridge from Ethereum."
          action={{
            label: "Get USDC",
            href: "https://www.coinbase.com/how-to-buy/usd-coin",
          }}
        />
        <CheckItem
          done={hasApproval}
          loading={allowanceLoading}
          label={`Approve USDC for ${role === "genius" ? "Collateral" : "Escrow"}`}
          hint={`Allow the ${role === "genius" ? "Collateral" : "Escrow"} contract to spend your USDC. This is a one-time approval.`}
          action={{
            label: role === "genius" ? "Go to Collateral" : "Go to Dashboard",
            href: role === "genius" ? "/genius" : "/idiot",
          }}
        />
        <CheckItem
          done={hasDeposit}
          loading={depositLoading}
          label={`Deposit USDC ${role === "genius" ? "as collateral" : "to escrow"} ($${depositAmount.toFixed(2)} deposited)`}
          hint={
            role === "genius"
              ? "Collateral backs your signals. You need enough to cover potential damages."
              : "Your escrow balance is used to purchase signals."
          }
          action={{
            label: role === "genius" ? "Deposit Collateral" : "Deposit to Escrow",
            href: role === "genius" ? "/genius" : "/idiot",
          }}
        />
      </div>
    </div>
  );
}
