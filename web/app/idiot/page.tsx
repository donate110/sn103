"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import Link from "next/link";
import { useAccount, useWalletClient } from "wagmi";
import { useRouter } from "next/navigation";
import { useEscrowBalance, useCreditBalance, useDepositEscrow, useWithdrawEscrow, useWalletUsdcBalance, useEarlyExit, humanizeError } from "@/lib/hooks";
import { useActiveSignals } from "@/lib/hooks/useSignals";
import { usePurchaseHistory } from "@/lib/hooks/usePurchaseHistory";
import { useIdiotAuditHistory } from "@/lib/hooks/useAuditHistory";
import { useActiveRelationships, type ActiveRelationship } from "@/lib/hooks/useActiveRelationships";
import { useLeaderboard } from "@/lib/hooks/useLeaderboard";
import { formatUsdc, parseUsdc, formatBps, truncateAddress } from "@/lib/types";
import { getPurchasedSignals, savePurchasedSignal } from "@/lib/preferences";
import { getSavedSignals, saveSavedSignalsEncrypted } from "@/lib/hooks/useSettledSignals";
import { getCachedMasterSeed } from "@/lib/crypto";
import { readRecoveryBlobFromChain, loadRecovery } from "@/lib/recovery";
import SignalPlot from "@/components/SignalPlot";
import OnboardingChecklist, { triggerOnboardingRefresh } from "@/components/OnboardingChecklist";

export default function IdiotDashboard() {
  const { isConnected, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { balance: escrowBalance, loading: escrowLoading, refresh: refreshEscrow } =
    useEscrowBalance(address);
  const { balance: walletUsdc, loading: walletUsdcLoading, refresh: refreshWalletUsdc } = useWalletUsdcBalance(address);
  const { balance: creditBalance, loading: creditLoading } =
    useCreditBalance(address);
  const { deposit: depositEscrow, loading: depositLoading } = useDepositEscrow();
  const { withdraw: withdrawEscrow, loading: withdrawLoading } = useWithdrawEscrow();

  const { purchases, loading: purchasesLoading } = usePurchaseHistory(address);
  const { audits, loading: auditsLoading } = useIdiotAuditHistory(address);

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);
  const [sportFilter, setSportFilter] = useState("");
  const [viewMode, setViewMode] = useState<"plot" | "list">("list");
  const [notionalMin, setNotionalMin] = useState(0);
  const [notionalMax, setNotionalMax] = useState(10000);
  const [feeMax, setFeeMax] = useState(2000);
  const [slaMin, setSlaMin] = useState(0);
  const [expiryFilter, setExpiryFilter] = useState("");
  const [geniusSearch, setGeniusSearch] = useState("");
  const [sortBy, setSortBy] = useState<"expiry" | "fee-asc" | "fee-desc" | "sla" | "score" | "relationship">("expiry");
  const [showFilters, setShowFilters] = useState(false);
  const { signals, loading: signalsLoading } = useActiveSignals(sportFilter || undefined);
  const { data: leaderboard } = useLeaderboard();
  const { relationships: myRelationships } = useActiveRelationships(address, "idiot");
  const router = useRouter();

  // Key recovery: if no local purchased data, check for on-chain recovery blob
  const [recoveryState, setRecoveryState] = useState<
    "idle" | "checking" | "prompting" | "loading" | "recovered" | "none" | "failed"
  >("idle");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const localPurchaseCount = address ? getPurchasedSignals(address).length : 0;

  useEffect(() => {
    if (!address || purchasesLoading || localPurchaseCount > 0 || recoveryState !== "idle") return;
    // Skip if already checked this session
    const cacheKey = `djinn:recovery_checked:${address}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached === "none") { setRecoveryState("none"); return; }
    if (cached === "prompting") { setRecoveryState("prompting"); return; }
    setRecoveryState("checking");
    readRecoveryBlobFromChain(address)
      .then((blob) => {
        const state = blob ? "prompting" : "none";
        setRecoveryState(state);
        try { sessionStorage.setItem(cacheKey, state); } catch {}
      })
      .catch(() => {
        setRecoveryState("none");
        try { sessionStorage.setItem(cacheKey, "none"); } catch {}
      });
  }, [address, purchasesLoading, localPurchaseCount, recoveryState]);

  const handleRecover = useCallback(async () => {
    if (!address || !walletClient) return;
    setRecoveryState("loading");
    setRecoveryError(null);
    try {
      const result = await loadRecovery(
        address,
        (params) => walletClient.signTypedData(params),
      );
      if (result && (result.signals.length > 0 || result.purchases.length > 0)) {
        if (result.signals.length > 0) {
          await saveSavedSignalsEncrypted(address, result.signals, getCachedMasterSeed());
        }
        for (const p of result.purchases) {
          savePurchasedSignal(address, p);
        }
        setRecoveryState("recovered");
      } else {
        setRecoveryState("failed");
        setRecoveryError("Recovery blob was empty or could not be decrypted");
      }
    } catch (err) {
      setRecoveryState("failed");
      setRecoveryError(err instanceof Error ? err.message : "Recovery failed");
    }
  }, [address, walletClient]);

  const geniusScoreMap = useMemo(() => {
    const map = new Map<string, { qualityScore: number; totalSignals: number; roi: number; proofCount: number; favCount: number; unfavCount: number }>();
    for (const entry of leaderboard) {
      map.set(entry.address.toLowerCase(), {
        qualityScore: entry.qualityScore,
        totalSignals: entry.totalSignals,
        roi: entry.roi,
        proofCount: entry.proofCount,
        favCount: entry.favCount,
        unfavCount: entry.unfavCount,
      });
    }
    return map;
  }, [leaderboard]);

  const geniusesWithOpenAuditSets = useMemo(() => {
    const set = new Set<string>();
    for (const rel of myRelationships) {
      if (rel.signalCount > 0 && rel.signalCount < 10) {
        set.add(rel.genius.toLowerCase());
      }
    }
    return set;
  }, [myRelationships]);

  const filteredSignals = useMemo(() => {
    const now = Date.now();
    const minBig = BigInt(notionalMin) * 1_000_000n;
    const maxBig = BigInt(notionalMax) * 1_000_000n;
    return signals.filter((s) => {
      if (s.maxNotional > 0n && s.maxNotional < minBig) return false;
      if (notionalMax < 10000 && s.maxNotional > maxBig) return false;
      if (feeMax < 2000 && Number(s.maxPriceBps) > feeMax) return false;
      if (slaMin > 0 && Number(s.slaMultiplierBps) < slaMin) return false;
      if (expiryFilter) {
        const hoursLeft = (Number(s.expiresAt) * 1000 - now) / 3_600_000;
        if (hoursLeft > parseInt(expiryFilter)) return false;
      }
      if (geniusSearch) {
        const q = geniusSearch.toLowerCase();
        if (!s.genius.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [signals, notionalMin, notionalMax, feeMax, slaMin, expiryFilter, geniusSearch]);

  const sortedSignals = useMemo(() => {
    const sorted = [...filteredSignals];
    switch (sortBy) {
      case "expiry":
        sorted.sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt));
        break;
      case "fee-asc":
        sorted.sort((a, b) => Number(a.maxPriceBps) - Number(b.maxPriceBps));
        break;
      case "fee-desc":
        sorted.sort((a, b) => Number(b.maxPriceBps) - Number(a.maxPriceBps));
        break;
      case "sla":
        sorted.sort((a, b) => Number(b.slaMultiplierBps) - Number(a.slaMultiplierBps));
        break;
      case "score":
        sorted.sort((a, b) => {
          const sa = geniusScoreMap.get(a.genius.toLowerCase())?.qualityScore ?? 0;
          const sb = geniusScoreMap.get(b.genius.toLowerCase())?.qualityScore ?? 0;
          return sb - sa;
        });
        break;
      case "relationship":
        sorted.sort((a, b) => {
          const aHas = geniusesWithOpenAuditSets.has(a.genius.toLowerCase()) ? 1 : 0;
          const bHas = geniusesWithOpenAuditSets.has(b.genius.toLowerCase()) ? 1 : 0;
          if (bHas !== aHas) return bHas - aHas;
          // Secondary sort: by expiry within each group
          return Number(a.expiresAt) - Number(b.expiresAt);
        });
        break;
    }
    return sorted;
  }, [filteredSignals, sortBy, geniusScoreMap, geniusesWithOpenAuditSets]);

  const handleDeposit = async () => {
    if (!depositAmount) return;
    setTxError(null);
    setTxSuccess(null);
    try {
      const result = await depositEscrow(parseUsdc(depositAmount));
      if (result === "approved") {
        // First-time: USDC spending approval completed.
        // Coinbase Smart Wallet can't handle chained popups, so we need a second click.
        setTxSuccess("Step 1 of 2 complete: USDC spending approved. Now click Deposit one more time to transfer your USDC.");
        return;
      }
      setTxSuccess(`Deposited ${depositAmount} USDC to escrow`);
      setDepositAmount("");
      refreshEscrow();
      refreshWalletUsdc();
      triggerOnboardingRefresh();
    } catch (err) {
      setTxError(humanizeError(err, "Deposit failed"));
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount) return;
    setTxError(null);
    setTxSuccess(null);
    try {
      await withdrawEscrow(parseUsdc(withdrawAmount));
      setTxSuccess(`Withdrew ${withdrawAmount} USDC from escrow`);
      triggerOnboardingRefresh();
      setWithdrawAmount("");
      refreshEscrow();
      refreshWalletUsdc();
    } catch (err) {
      setTxError(err instanceof Error ? err.message : "Withdraw failed");
    }
  };

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-full bg-idiot-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-idiot-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Idiot Dashboard</h1>
            <p className="text-sm text-slate-500">Browse signals, buy picks from verified analysts</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 mb-6">
          <h3 className="font-semibold text-slate-900 text-sm mb-4">Getting started</h3>
          <div className="space-y-3">
            {[
              { step: "1", label: "Connect your wallet", hint: "Click \"Get Started\" in the top right. We recommend Coinbase Smart Wallet: free to create, no gas fees, works with just an email.", active: true },
              { step: "2", label: "Switch to Base network", hint: "Your wallet will prompt you. Base is Coinbase's fast, cheap blockchain." },
              { step: "3", label: "Get USDC on Base", hint: "USDC is a stablecoin worth $1. Start small ($10-50) while you learn." },
              { step: "4", label: "Deposit to escrow", hint: "Your escrow balance is what you use to buy signals from Geniuses." },
              { step: "5", label: "Browse and buy signals", hint: "Check track records, buy picks, and track your results." },
            ].map(({ step, label, hint, active }) => (
              <div key={step} className="flex items-start gap-3">
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${active ? "bg-idiot-100 text-idiot-700" : "bg-slate-100 text-slate-400"}`}>
                  {step}
                </div>
                <div>
                  <p className={`text-sm font-medium ${active ? "text-slate-900" : "text-slate-400"}`}>{label}</p>
                  {active && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-400 text-center">
          New to crypto?{" "}
          <a href="/docs/how-it-works" className="text-slate-600 underline">Learn how Djinn works</a>
        </p>
      </div>
    );
  }

  return (
    <div>
      <OnboardingChecklist role="idiot" position="top" />
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Idiot Dashboard</h1>
          <p className="text-slate-500 mt-1">
            Browse signals, manage your balance, and track purchases
          </p>
        </div>
      </div>

      {/* Balances */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Wallet
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {walletUsdcLoading ? "..." : `$${formatUsdc(walletUsdc)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">USDC in your connected wallet</p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Escrow Balance
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {escrowLoading ? "..." : `$${formatUsdc(escrowBalance)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">Deposited for instant signal purchases</p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Credits
          </p>
          <p className="text-2xl font-bold text-idiot-500 mt-2">
            {creditLoading ? "..." : formatUsdc(creditBalance)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            From settlements, offsets fees
          </p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Signals Purchased
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {purchasesLoading ? "..." : purchases.length}
          </p>
          <p className="text-xs text-slate-500 mt-1">Total signals bought</p>
        </div>
      </div>

      {/* Key Recovery Banner */}
      {recoveryState === "prompting" && (
        <div className="card mb-8 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-800">Recovery Backup Detected</h3>
              <p className="text-xs text-amber-700 mt-1">
                No local purchase data found, but a recovery backup exists on-chain.
                Sign a message to restore your data.
              </p>
              <button
                onClick={handleRecover}
                className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
              >
                Restore from Backup
              </button>
            </div>
          </div>
        </div>
      )}

      {recoveryState === "loading" && (
        <div className="card mb-8 border-blue-200 bg-blue-50">
          <p className="text-sm text-blue-700">Restoring data from on-chain backup... Sign the message in your wallet.</p>
        </div>
      )}

      {recoveryState === "recovered" && (
        <div className="card mb-8 border-green-200 bg-green-50">
          <p className="text-sm text-green-700">Data restored successfully from on-chain backup.</p>
        </div>
      )}

      {recoveryState === "failed" && (
        <div className="card mb-8 border-red-200 bg-red-50">
          <p className="text-sm text-red-600">{recoveryError || "Recovery failed"}</p>
          <button
            onClick={handleRecover}
            className="mt-2 text-xs text-red-700 underline hover:text-red-800"
          >
            Try again
          </button>
        </div>
      )}

      {/* Escrow Management */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">
          Balance Management
        </h2>
        <div className="card">
          {txSuccess && (
            <div className="rounded-lg bg-green-50 border border-green-200 p-3 mb-4" role="status">
              <p className="text-xs text-green-700">{txSuccess}</p>
            </div>
          )}
          {txError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 mb-4" role="alert">
              <p className="text-xs text-red-600">{txError}</p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <form onSubmit={(e) => { e.preventDefault(); handleDeposit(); }}>
              <label htmlFor="depositEscrow" className="label">Deposit USDC</label>
              <div className="flex gap-2">
                <input
                  id="depositEscrow"
                  type="number"
                  inputMode="decimal"
                  placeholder="Amount (USDC)"
                  className="input flex-1"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn-primary whitespace-nowrap"
                  disabled={depositLoading || !depositAmount}
                >
                  {depositLoading ? "Depositing..." : "Deposit"}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Deposits require USDC approval first
              </p>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); handleWithdraw(); }}>
              <label htmlFor="withdrawEscrow" className="label">Withdraw USDC</label>
              <div className="flex gap-2">
                <input
                  id="withdrawEscrow"
                  type="number"
                  inputMode="decimal"
                  placeholder="Amount (USDC)"
                  className="input flex-1"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn-secondary whitespace-nowrap"
                  disabled={withdrawLoading || !withdrawAmount}
                >
                  {withdrawLoading ? "Withdrawing..." : "Withdraw"}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Withdraw available balance
              </p>
            </form>
          </div>
        </div>
      </section>

      {/* Browse Signals */}
      <section className="mb-8">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-xl font-semibold text-slate-900">
            Available Signals
            {!signalsLoading && (
              <span className="text-sm font-normal text-slate-400 ml-2">
                {sortedSignals.length === signals.length
                  ? `${signals.length} total`
                  : `${sortedSignals.length} matching filters (${signals.length} total)`}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto scrollbar-hide">
            <select
              className="input w-auto shrink-0"
              value={sportFilter}
              onChange={(e) => setSportFilter(e.target.value)}
              aria-label="Filter by sport"
            >
              <option value="">All Sports</option>
              <option value="NFL">NFL</option>
              <option value="NBA">NBA</option>
              <option value="MLB">MLB</option>
              <option value="NHL">NHL</option>
              <option value="Soccer">Soccer</option>
            </select>
            <select
              className="input w-auto shrink-0"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label="Sort signals"
            >
              <option value="expiry">Expiring soon</option>
              <option value="relationship">My relationships</option>
              <option value="fee-asc">Fee: low to high</option>
              <option value="fee-desc">Fee: high to low</option>
              <option value="sla">Highest SLA</option>
              <option value="score">Genius score</option>
            </select>
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                showFilters
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
              }`}
            >
              Filters{(feeMax < 2000 || slaMin > 0 || expiryFilter || geniusSearch || notionalMax < 10000) && (
                <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-idiot-500 text-white text-[10px]">
                  {[feeMax < 2000, slaMin > 0, expiryFilter, geniusSearch, notionalMax < 10000].filter(Boolean).length}
                </span>
              )}
            </button>
            <div className="flex rounded-lg border border-slate-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === "list"
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-500 hover:bg-slate-50"
                }`}
                aria-label="List view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("plot")}
                className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === "plot"
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-500 hover:bg-slate-50"
                }`}
                aria-label="Dot plot view"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <circle cx="8" cy="8" r="2" fill="currentColor" />
                  <circle cx="16" cy="12" r="2" fill="currentColor" />
                  <circle cx="12" cy="16" r="2" fill="currentColor" />
                  <circle cx="18" cy="6" r="2" fill="currentColor" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Expanded filter panel */}
        {showFilters && (
          <div className="card mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label htmlFor="feeMaxFilter" className="text-xs text-slate-500 uppercase tracking-wide">
                  Max Fee
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    id="feeMaxFilter"
                    type="range"
                    min={0}
                    max={2000}
                    step={50}
                    value={feeMax}
                    onChange={(e) => setFeeMax(Number(e.target.value))}
                    className="flex-1 accent-idiot-500"
                  />
                  <span className="text-xs text-slate-700 tabular-nums w-10 text-right">
                    {feeMax < 2000 ? `${(feeMax / 100).toFixed(0)}%` : "Any"}
                  </span>
                </div>
              </div>
              <div>
                <label htmlFor="slaMinFilter" className="text-xs text-slate-500 uppercase tracking-wide">
                  Min SLA (Skin in Game)
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    id="slaMinFilter"
                    type="range"
                    min={0}
                    max={30000}
                    step={1000}
                    value={slaMin}
                    onChange={(e) => setSlaMin(Number(e.target.value))}
                    className="flex-1 accent-idiot-500"
                  />
                  <span className="text-xs text-slate-700 tabular-nums w-12 text-right">
                    {slaMin > 0 ? `${(slaMin / 100).toFixed(0)}%` : "Any"}
                  </span>
                </div>
              </div>
              <div>
                <label htmlFor="notionalFilter" className="text-xs text-slate-500 uppercase tracking-wide">
                  Max Notional
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    id="notionalFilter"
                    type="range"
                    min={0}
                    max={10000}
                    step={100}
                    value={notionalMax}
                    onChange={(e) => setNotionalMax(Number(e.target.value))}
                    className="flex-1 accent-idiot-500"
                  />
                  <span className="text-xs text-slate-700 tabular-nums w-12 text-right">
                    {notionalMax < 10000 ? `$${notionalMax.toLocaleString()}` : "Any"}
                  </span>
                </div>
              </div>
              <div>
                <label htmlFor="expiryFilterSelect" className="text-xs text-slate-500 uppercase tracking-wide">
                  Expiring Within
                </label>
                <select
                  id="expiryFilterSelect"
                  className="input mt-1"
                  value={expiryFilter}
                  onChange={(e) => setExpiryFilter(e.target.value)}
                >
                  <option value="">Any time</option>
                  <option value="1">1 hour</option>
                  <option value="6">6 hours</option>
                  <option value="24">24 hours</option>
                  <option value="72">3 days</option>
                </select>
              </div>
              <div>
                <label htmlFor="geniusSearchInput" className="text-xs text-slate-500 uppercase tracking-wide">
                  Genius Address
                </label>
                <input
                  id="geniusSearchInput"
                  type="text"
                  placeholder="0x..."
                  className="input mt-1"
                  value={geniusSearch}
                  onChange={(e) => setGeniusSearch(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => {
                    setFeeMax(2000);
                    setSlaMin(0);
                    setNotionalMax(10000);
                    setExpiryFilter("");
                    setGeniusSearch("");
                  }}
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Reset filters
                </button>
              </div>
            </div>
          </div>
        )}

        {signalsLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="card">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="h-4 bg-slate-200 rounded w-16" />
                      <div className="h-3 bg-slate-100 rounded w-24" />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="h-3 bg-slate-100 rounded w-20" />
                      <div className="h-3 bg-slate-100 rounded w-16" />
                      <div className="h-3 bg-slate-100 rounded w-14" />
                    </div>
                  </div>
                  <div className="h-4 bg-slate-100 rounded w-12 shrink-0 ml-3" />
                </div>
              </div>
            ))}
          </div>
        ) : sortedSignals.length === 0 ? (
          <div className="card">
            <p className="text-center text-slate-500 py-8">
              {signals.length === 0
                ? "No signals available right now. Check back soon; new signals are committed as Geniuses publish their analysis."
                : "No signals match your filters. Try adjusting or resetting them."}
            </p>
          </div>
        ) : viewMode === "plot" ? (
          <div className="card">
            <SignalPlot
              signals={sortedSignals}
              onSelect={(id) => router.push(`/idiot/signal/${id}`)}
              geniusScoreMap={geniusScoreMap}
            />
          </div>
        ) : (
          <div className="space-y-3">
            {sortedSignals.map((s) => {
              const isExclusive = s.minNotional > 0n && s.minNotional === s.maxNotional;
              const feePerHundred = ((100 * Number(s.maxPriceBps)) / 10_000).toFixed(2);
              const slaPercent = formatBps(s.slaMultiplierBps);
              const expires = new Date(Number(s.expiresAt) * 1000);
              const hoursLeft = Math.max(0, (expires.getTime() - Date.now()) / 3_600_000);
              const timeLabel = hoursLeft < 1
                ? `${Math.round(hoursLeft * 60)}m left`
                : hoursLeft < 24
                  ? `${Math.round(hoursLeft)}h left`
                  : `${Math.floor(hoursLeft / 24)}d left`;
              const geniusStats = geniusScoreMap.get(s.genius.toLowerCase());
              const hasOpenAuditSet = geniusesWithOpenAuditSets.has(s.genius.toLowerCase());
              return (
                <Link
                  key={s.signalId}
                  href={`/idiot/signal/${s.signalId}`}
                  data-testid="signal-card"
                  className={`card block hover:border-idiot-300 active:bg-slate-50 transition-colors${hasOpenAuditSet ? " ring-1 ring-idiot-200" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-900">
                          {s.sport}
                        </span>
                        <span className="text-xs text-slate-400">
                          by {truncateAddress(s.genius)}
                        </span>
                        {isExclusive && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                            Exclusive
                          </span>
                        )}
                        {hasOpenAuditSet && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-idiot-100 text-idiot-700">
                            Open audit set
                          </span>
                        )}
                        {geniusStats && (
                          <span className={`text-xs font-medium ${geniusStats.qualityScore >= 0 ? "text-green-600" : "text-red-500"}`}>
                            {geniusStats.qualityScore >= 0 ? "+" : ""}{geniusStats.qualityScore.toFixed(2)} QS
                            {geniusStats.roi !== 0 && (
                              <span className="ml-1">
                                {geniusStats.roi >= 0 ? "+" : ""}{geniusStats.roi.toFixed(1)}%
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 sm:gap-3 mt-1.5 flex-wrap">
                        <span className="text-xs text-slate-500">
                          ${feePerHundred}/$100
                        </span>
                        <span className="text-xs text-slate-500">
                          {slaPercent} SLA
                        </span>
                        {s.maxNotional > 0n && (
                          <span className="text-xs text-slate-500">
                            max ${formatUsdc(s.maxNotional)}
                          </span>
                        )}
                        <span className={`text-xs ${hoursLeft < 2 ? "text-red-500 font-medium" : "text-slate-500"}`}>
                          {timeLabel}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs text-idiot-500 font-medium shrink-0 ml-3 mt-0.5">
                      View &rarr;
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Purchase History */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">
          Purchase History
        </h2>
        {purchasesLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="card">
                <div className="flex items-center justify-between mb-2">
                  <div className="h-4 bg-slate-200 rounded w-32" />
                  <div className="h-5 bg-slate-100 rounded-full w-20" />
                </div>
                <div className="flex gap-4">
                  <div className="h-3 bg-slate-100 rounded w-16" />
                  <div className="h-3 bg-slate-100 rounded w-16" />
                  <div className="h-3 bg-slate-100 rounded w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : purchases.length === 0 ? (
          <div className="card text-center py-8">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
              </svg>
            </div>
            <p className="text-slate-500 mb-1">No purchases yet</p>
            <p className="text-xs text-slate-400">Browse available signals above to get started.</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="card overflow-x-auto hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="pb-3 font-medium">Signal</th>
                    <th className="pb-3 font-medium">Notional</th>
                    <th className="pb-3 font-medium">Fee Paid</th>
                    <th className="pb-3 font-medium">Credits Used</th>
                    <th className="pb-3 font-medium">Status</th>
                    <th className="pb-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {[...purchases].reverse().map((p) => (
                    <tr key={p.purchaseId} className="border-b border-slate-100 cursor-pointer hover:bg-slate-50" onClick={() => window.location.href = `/idiot/signal/${p.signalId}`}>
                      <td className="py-3 text-idiot-600 underline">{truncateAddress(p.signalId)}</td>
                      <td className="py-3">${formatUsdc(BigInt(p.notional))}</td>
                      <td className="py-3">${formatUsdc(BigInt(p.feePaid))}</td>
                      <td className="py-3">
                        {p.creditUsed > 0n ? (
                          <span className="text-idiot-500">{formatUsdc(p.creditUsed)}</span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-3">
                        <span className="rounded-full px-2 py-0.5 text-xs bg-slate-100 text-slate-600">
                          Purchased
                        </span>
                      </td>
                      <td className="py-3 text-slate-500">Block {p.blockNumber}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {[...purchases].reverse().map((p) => (
                <div key={p.purchaseId} className="card cursor-pointer hover:border-idiot-300 active:bg-slate-50 transition-colors" onClick={() => window.location.href = `/idiot/signal/${p.signalId}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-idiot-600 underline">
                      Signal {truncateAddress(p.signalId)}
                    </span>
                    <span className="rounded-full px-2 py-0.5 text-xs bg-slate-100 text-slate-600">
                      Purchased
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <div>
                      <span className="text-slate-500">Notional</span>
                      <p className="font-medium text-slate-900">${formatUsdc(BigInt(p.notional))}</p>
                    </div>
                    <div>
                      <span className="text-slate-500">Fee</span>
                      <p className="font-medium text-slate-900">${formatUsdc(BigInt(p.feePaid))}</p>
                    </div>
                    {p.creditUsed > 0n && (
                      <div>
                        <span className="text-slate-500">Credits</span>
                        <p className="font-medium text-idiot-500">{formatUsdc(p.creditUsed)}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-slate-500">Block</span>
                      <p className="text-slate-600">{p.blockNumber}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* Active Relationships */}
      <RelationshipsSection address={address} />

      {/* Audit History */}
      <section>
        <h2 className="text-xl font-semibold text-slate-900 mb-4">
          Settlement History
        </h2>
        {auditsLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="card">
                <div className="flex items-center justify-between mb-2">
                  <div className="h-4 bg-slate-200 rounded w-40" />
                  <div className="h-5 bg-slate-100 rounded-full w-20" />
                </div>
                <div className="flex gap-4">
                  <div className="h-3 bg-slate-100 rounded w-16" />
                  <div className="h-3 bg-slate-100 rounded w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : audits.length === 0 ? (
          <div className="card text-center py-8">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <p className="text-slate-500 mb-1">No settlements yet</p>
            <p className="text-xs text-slate-400">Settlements happen after every 10 signals in a Genius-Idiot pair are resolved.</p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="card overflow-x-auto hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="pb-3 font-medium">Cycle</th>
                    <th className="pb-3 font-medium">Genius</th>
                    <th className="pb-3 font-medium">Result</th>
                    <th className="pb-3 font-medium">Payout</th>
                    <th className="pb-3 font-medium">Credits</th>
                    <th className="pb-3 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((a, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-3">{a.cycle.toString()}</td>
                      <td className="py-3">{truncateAddress(a.genius)}</td>
                      <td className="py-3">
                        {a.isEarlyExit ? (
                          <span className="rounded-full px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700">Early Exit</span>
                        ) : Number(a.qualityScore) >= 0 ? (
                          <span className="rounded-full px-2 py-0.5 text-xs bg-green-100 text-green-700">Favorable</span>
                        ) : (
                          <span className="rounded-full px-2 py-0.5 text-xs bg-red-100 text-red-700">Unfavorable</span>
                        )}
                      </td>
                      <td className="py-3">
                        {a.trancheA > 0n ? (
                          <span className="text-green-600">${formatUsdc(a.trancheA)}</span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-3">
                        {a.trancheB > 0n ? (
                          <span className="text-idiot-500">{formatUsdc(a.trancheB)}</span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-3 text-slate-500">Block {a.blockNumber}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="space-y-3 md:hidden">
              {audits.map((a, i) => (
                <div key={i} className="card">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-slate-900">
                      Cycle {a.cycle.toString()} &middot; {truncateAddress(a.genius)}
                    </span>
                    {a.isEarlyExit ? (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700">Early Exit</span>
                    ) : Number(a.qualityScore) >= 0 ? (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-green-100 text-green-700">Favorable</span>
                    ) : (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-red-100 text-red-700">Unfavorable</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {a.trancheA > 0n && (
                      <div>
                        <span className="text-slate-500">Payout</span>
                        <p className="font-medium text-green-600">${formatUsdc(a.trancheA)}</p>
                      </div>
                    )}
                    {a.trancheB > 0n && (
                      <div>
                        <span className="text-slate-500">Credits</span>
                        <p className="font-medium text-idiot-500">{formatUsdc(a.trancheB)}</p>
                      </div>
                    )}
                    <div>
                      <span className="text-slate-500">Block</span>
                      <p className="text-slate-600">{a.blockNumber}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <OnboardingChecklist role="idiot" position="bottom" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active Relationships Section (auto-discovered)
// ---------------------------------------------------------------------------

function RelationshipsSection({ address }: { address: string | undefined }) {
  const { relationships, loading: relLoading } = useActiveRelationships(address, "idiot");
  const { earlyExit, loading: exitLoading, error: exitError } = useEarlyExit();
  const [exitingPair, setExitingPair] = useState<string | null>(null);
  const [successPair, setSuccessPair] = useState<string | null>(null);

  const handleEarlyExit = async (rel: ActiveRelationship) => {
    if (!address) return;
    const key = `${rel.genius}:${rel.idiot}`;
    setExitingPair(key);
    setSuccessPair(null);
    try {
      await earlyExit(rel.genius, rel.idiot);
      setSuccessPair(key);
      setExitingPair(null);
    } catch {
      setExitingPair(null);
    }
  };

  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-slate-900 mb-4">
        Active Relationships
      </h2>
      {relLoading ? (
        <div className="card">
          <p className="text-center text-slate-500 py-8">Loading relationships...</p>
        </div>
      ) : relationships.length === 0 ? (
        <div className="card">
          <p className="text-center text-slate-500 py-8">
            No active relationships. Relationships form when you purchase a signal from a Genius.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {relationships.map((rel) => {
            const key = `${rel.genius}:${rel.idiot}`;
            const isExiting = exitingPair === key;
            const isSuccess = successPair === key;
            return (
              <div key={key} className="card">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Genius: {truncateAddress(rel.genius)}
                    </p>
                    <div className="flex items-center gap-4 mt-1 text-xs text-slate-500">
                      <span>Cycle {rel.currentCycle}</span>
                      <span>
                        {rel.signalCount} / 10 signals
                      </span>
                      <span className={rel.qualityScore >= 0 ? "text-green-600" : "text-red-500"}>
                        QS: {rel.qualityScore >= 0 ? "+" : ""}{rel.qualityScore}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    {rel.isAuditReady ? (
                      <span className="rounded-full px-3 py-1 text-xs font-medium bg-idiot-100 text-idiot-600 border border-idiot-200">
                        Audit Ready
                      </span>
                    ) : (
                      <>
                        {isSuccess ? (
                          <span className="text-xs text-green-600 font-medium">Settled</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleEarlyExit(rel)}
                            disabled={exitLoading || isExiting}
                            className="btn-secondary text-xs py-1.5 px-3"
                          >
                            {isExiting ? "Settling..." : "Early Exit"}
                          </button>
                        )}
                      </>
                    )}
                    <div className="w-20 bg-slate-100 rounded-full h-1.5">
                      <div
                        className="bg-idiot-500 h-1.5 rounded-full transition-all"
                        style={{ width: `${(rel.signalCount / 10) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
                {isExiting && exitError && (
                  <div className="rounded-lg bg-red-50 border border-red-200 p-2 mt-2" role="alert">
                    <p className="text-xs text-red-600">{exitError}</p>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-xs text-slate-400 mt-2">
            Early exit settles damages in Djinn Credits only (no USDC). All signal outcomes must be finalized first.
          </p>
        </div>
      )}
    </section>
  );
}
