"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, useWalletClient } from "wagmi";
import QualityScore from "@/components/QualityScore";
import { useCollateral, useDepositCollateral, useWithdrawCollateral, useWalletUsdcBalance, useEarlyExit, useCancelSignal, humanizeError } from "@/lib/hooks";
import { invalidateSignalCache } from "@/lib/events";
import { useActiveSignals } from "@/lib/hooks/useSignals";
import { useAuditHistory } from "@/lib/hooks/useAuditHistory";
import { useEncryptedSignals } from "@/lib/hooks/useEncryptedSignals";
import { saveSavedSignalsEncrypted } from "@/lib/hooks/useSettledSignals";
import { readRecoveryBlobFromChain, loadRecovery } from "@/lib/recovery";
import { useActiveRelationships, type ActiveRelationship } from "@/lib/hooks/useActiveRelationships";
import { formatUsdc, parseUsdc, formatBps, truncateAddress } from "@/lib/types";
import OnboardingChecklist, { triggerOnboardingRefresh } from "@/components/OnboardingChecklist";

export default function GeniusDashboard() {
  const { isConnected, address } = useAccount();
  const { deposit, locked, available, loading, refresh: refreshCollateral } = useCollateral(address);
  const { balance: walletUsdc, loading: walletUsdcLoading, refresh: refreshWalletUsdc } = useWalletUsdcBalance(address);
  const { deposit: depositCollateral, loading: depositLoading } = useDepositCollateral();
  const { withdraw: withdrawCollateral, loading: withdrawLoading } = useWithdrawCollateral();
  const { signals: mySignals, loading: signalsLoading, forceRefresh: forceRefreshSignals } = useActiveSignals(undefined, address, true);
  const { audits, loading: auditsLoading, aggregateQualityScore } = useAuditHistory(address);
  const { data: walletClient } = useWalletClient();

  // Encrypted signal data from localStorage
  const {
    signals: savedSignals,
    loading: savedLoading,
    locked: savedLocked,
    unlock: unlockSaved,
    refresh: refreshSaved,
  } = useEncryptedSignals();

  const verifiedMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const s of savedSignals) map.set(s.signalId, s.minerVerified === true);
    return map;
  }, [savedSignals]);

  // On-chain recovery state machine
  const [recoveryState, setRecoveryState] = useState<
    "idle" | "checking" | "prompting" | "loading" | "recovered" | "none" | "failed"
  >("idle");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const recoveryCheckedRef = useRef(false);

  useEffect(() => {
    if (recoveryCheckedRef.current) return;
    if (!address || savedLoading || savedSignals.length > 0 || savedLocked) return;
    recoveryCheckedRef.current = true;
    setRecoveryState("checking");
    readRecoveryBlobFromChain(address)
      .then((blob) => setRecoveryState(blob ? "prompting" : "none"))
      .catch(() => setRecoveryState("none"));
  }, [address, savedLoading, savedSignals.length, savedLocked]);

  const handleRecover = useCallback(async () => {
    if (!address || !walletClient) return;
    setRecoveryState("loading");
    setRecoveryError(null);
    try {
      const result = await loadRecovery(
        address,
        (params) => walletClient.signTypedData(params),
      );
      if (result && result.signals.length > 0) {
        const { getCachedMasterSeed } = await import("@/lib/crypto");
        await saveSavedSignalsEncrypted(address, result.signals, getCachedMasterSeed());
        await refreshSaved();
        setRecoveryState("recovered");
      } else {
        setRecoveryState("failed");
        setRecoveryError("Recovery blob was empty or could not be decrypted");
      }
    } catch (err) {
      setRecoveryState("failed");
      setRecoveryError(err instanceof Error ? err.message : "Recovery failed");
    }
  }, [address, walletClient, refreshSaved]);

  const { cancelSignal, loading: cancelLoading } = useCancelSignal();
  const [cancellingAll, setCancellingAll] = useState(false);
  const [cancelProgress, setCancelProgress] = useState("");

  const [showExpired, setShowExpired] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [txError, setTxError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<string | null>(null);

  const handleDeposit = async () => {
    if (!depositAmount) return;
    setTxError(null);
    setTxSuccess(null);
    try {
      const result = await depositCollateral(parseUsdc(depositAmount));
      if (result === "approved") {
        // First-time: USDC spending approval completed.
        // Coinbase Smart Wallet can't handle chained popups, so we need a second click.
        setTxSuccess("Step 1 of 2 complete: USDC spending approved. Now click Deposit one more time to transfer your USDC.");
        return;
      }
      setDepositAmount("");
      setTxSuccess(`Deposited ${depositAmount} USDC collateral`);
      refreshCollateral();
      refreshWalletUsdc();
      triggerOnboardingRefresh();
    } catch (err) {
      setTxError(humanizeError(err, "Deposit failed"));
    }
  };

  const cancelProgressRef = useRef("");
  const handleCancelAll = async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const active = mySignals.filter((s) => s.expiresAt > now && !s.cancelled);
    if (active.length === 0) return;
    setCancellingAll(true);
    setCancelProgress(`Cancelling 1 of ${active.length}...`);
    setTxError(null);
    setTxSuccess(null);
    let cancelled = 0;
    let skipped = 0;
    for (let i = 0; i < active.length; i++) {
      const signal = active[i];
      cancelProgressRef.current = `Cancelling ${i + 1} of ${active.length}...`;
      try {
        await cancelSignal(BigInt(signal.signalId));
        cancelled++;
        // Brief delay between txs; Coinbase Smart Wallet (ERC-4337)
        // needs time to update its internal nonce after each UserOperation.
        // Update displayed progress only between txs (not every iteration).
        if (i < active.length - 1) {
          setCancelProgress(cancelProgressRef.current);
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch {
        // Signal may already be cancelled; skip and continue
        skipped++;
      }
    }
    setCancellingAll(false);
    setCancelProgress("");
    if (cancelled > 0 || skipped > 0) {
      invalidateSignalCache(address);
      forceRefreshSignals();
      const parts = [];
      if (cancelled > 0) parts.push(`Cancelled ${cancelled}`);
      if (skipped > 0) parts.push(`${skipped} already cancelled`);
      setTxSuccess(parts.join(", "));
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawAmount) return;
    setTxError(null);
    setTxSuccess(null);
    try {
      await withdrawCollateral(parseUsdc(withdrawAmount));
      setWithdrawAmount("");
      setTxSuccess(`Withdrew ${withdrawAmount} USDC collateral`);
      triggerOnboardingRefresh();
      refreshCollateral();
      refreshWalletUsdc();
    } catch (err) {
      setTxError(humanizeError(err, "Withdraw failed"));
    }
  };

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-full bg-genius-100 flex items-center justify-center">
            <svg className="w-6 h-6 text-genius-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Genius Dashboard</h1>
            <p className="text-sm text-slate-500">Sell predictions, build your track record</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 mb-6">
          <h3 className="font-semibold text-slate-900 text-sm mb-4">Getting started</h3>
          <div className="space-y-3">
            {[
              { step: "1", label: "Connect your wallet", hint: "Click \"Get Started\" in the top right. We recommend Coinbase Smart Wallet: free to create, no gas fees, works with just an email.", active: true },
              { step: "2", label: "Switch to Base network", hint: "Your wallet will prompt you. Base is Coinbase's fast, cheap blockchain." },
              { step: "3", label: "Get USDC on Base", hint: "USDC is a stablecoin worth $1. Start small ($10-50) while you learn." },
              { step: "4", label: "Deposit collateral", hint: "Your \"skin in the game.\" Backs your predictions; slashed if you underperform." },
              { step: "5", label: "Create your first signal", hint: "Pick a game, set your price, and start selling." },
            ].map(({ step, label, hint, active }) => (
              <div key={step} className="flex items-start gap-3">
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${active ? "bg-genius-100 text-genius-700" : "bg-slate-100 text-slate-400"}`}>
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
      <OnboardingChecklist role="genius" position="top" />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Genius Dashboard</h1>
          <p className="text-slate-500 mt-1">
            Manage your signals, collateral, and track record
          </p>
        </div>
        <div className="flex gap-3 flex-shrink-0">
          <Link href="/genius/track-record" className="btn-secondary text-sm">
            Track Record
          </Link>
          <Link href="/genius/signal/new" className="btn-primary text-sm">
            Create Signal
          </Link>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Wallet
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {walletUsdcLoading ? "..." : `$${formatUsdc(walletUsdc)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">USDC in your connected wallet</p>
        </div>

        <div className="card col-span-1 md:col-span-1">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Collateral
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {loading ? "..." : `$${formatUsdc(deposit)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">USDC deposited into the collateral contract</p>
          <div className="mt-3 pt-3 border-t border-slate-100 flex gap-4">
            <div>
              <p className="text-xs text-slate-400">Locked</p>
              <p className="text-sm font-semibold text-genius-500">
                {loading ? "..." : `$${formatUsdc(locked)}`}
              </p>
              <p className="text-[10px] text-slate-400">Backing active signals</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Unlocked</p>
              <p className="text-sm font-semibold text-green-600">
                {loading ? "..." : `$${formatUsdc(available)}`}
              </p>
              <p className="text-[10px] text-slate-400">Available to use or withdraw</p>
            </div>
          </div>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Quality Score
          </p>
          <div className="mt-3">
            <QualityScore score={Number(aggregateQualityScore)} size="md" />
          </div>
        </div>
      </div>

      {/* Locked data banner */}
      {savedLocked && (
        <div className="rounded-lg border border-genius-200 bg-genius-50 p-4 mb-8">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-genius-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-semibold text-genius-800">Signal Data Locked</p>
              <p className="text-xs text-genius-700 mt-1">
                Your private signal data is encrypted. Sign to unlock real picks and verification status.
              </p>
              <button
                type="button"
                onClick={unlockSaved}
                className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg bg-genius-600 text-white hover:bg-genius-700 transition-colors"
              >
                Unlock Data
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recovery banner */}
      {recoveryState === "prompting" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-8">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-semibold text-amber-800">Recovery Backup Detected</p>
              <p className="text-xs text-amber-700 mt-1">
                No local signal data found, but a recovery backup exists on-chain. Restore it to see your real picks and verification status.
              </p>
              <button
                type="button"
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
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-8">
          <p className="text-sm text-blue-700 animate-pulse">Restoring data from on-chain backup...</p>
        </div>
      )}
      {recoveryState === "recovered" && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 mb-8">
          <p className="text-sm text-green-700">Data restored successfully from on-chain backup.</p>
        </div>
      )}
      {recoveryState === "failed" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 mb-8">
          <p className="text-sm text-red-600">{recoveryError || "Recovery failed"}</p>
          <button
            type="button"
            onClick={() => setRecoveryState("idle")}
            className="mt-2 text-xs text-red-500 hover:text-red-700 underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Collateral Management */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">
          Collateral Management
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
              <label htmlFor="depositCollateral" className="label">Deposit USDC Collateral</label>
              <div className="flex gap-2">
                <input
                  id="depositCollateral"
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
              <p className="text-xs text-slate-400 mt-1">
                First deposit requires a one-time USDC approval.
              </p>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); handleWithdraw(); }}>
              <label htmlFor="withdrawCollateral" className="label">Withdraw Available Collateral</label>
              <div className="flex gap-2">
                <input
                  id="withdrawCollateral"
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
            </form>
          </div>
        </div>
      </section>

      {/* My Signals */}
      <section className="mb-8">
        {(() => {
          const now = BigInt(Math.floor(Date.now() / 1000));
          const notCancelled = mySignals.filter((s) => !s.cancelled);
          const activeSignals = notCancelled.filter((s) => s.expiresAt > now);
          const expiredSignals = notCancelled.filter((s) => s.expiresAt <= now);
          const displayedSignals = showExpired
            ? [...mySignals].sort((a, b) => Number(b.expiresAt) - Number(a.expiresAt))
            : [...activeSignals].sort((a, b) => Number(b.expiresAt) - Number(a.expiresAt));

          return (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-slate-900">
                  My Signals
                </h2>
                {!signalsLoading && mySignals.length > 0 && (
                  <div className="flex items-center gap-3">
                    {activeSignals.length > 0 && (
                      <button
                        type="button"
                        onClick={handleCancelAll}
                        disabled={cancellingAll || cancelLoading}
                        className="text-xs text-red-500 hover:text-red-700 font-medium disabled:opacity-50"
                      >
                        {cancellingAll ? cancelProgress : "Cancel All"}
                      </button>
                    )}
                    <span className="text-xs text-slate-500">
                      {activeSignals.length} active
                      {expiredSignals.length > 0 && (
                        <> &middot; {expiredSignals.length} expired</>
                      )}
                    </span>
                    {expiredSignals.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowExpired(!showExpired)}
                        className="text-xs text-genius-500 hover:text-genius-600 font-medium transition-colors"
                      >
                        {showExpired ? "Hide expired" : "Show expired"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              {signalsLoading ? (
                <div className="animate-pulse space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="card flex items-center justify-between">
                      <div className="flex-1">
                        <div className="h-4 bg-slate-200 rounded w-48 mb-2" />
                        <div className="h-3 bg-slate-100 rounded w-72" />
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-4">
                        <div className="h-6 bg-slate-100 rounded-full w-16" />
                        <div className="h-4 bg-slate-100 rounded w-4" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : mySignals.length === 0 ? (
                <div className="card text-center py-8">
                  <div className="w-12 h-12 rounded-full bg-genius-50 flex items-center justify-center mx-auto mb-3">
                    <svg className="w-6 h-6 text-genius-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                    </svg>
                  </div>
                  <p className="text-slate-500 mb-1">No signals yet</p>
                  <p className="text-xs text-slate-400">
                    Create your first signal to start building your track record.
                  </p>
                </div>
              ) : displayedSignals.length === 0 ? (
                <div className="card">
                  <p className="text-center text-slate-500 py-8">
                    No active signals.{" "}
                    <button
                      type="button"
                      onClick={() => setShowExpired(true)}
                      className="text-genius-500 hover:text-genius-600 font-medium"
                    >
                      Show {expiredSignals.length} expired signal{expiredSignals.length !== 1 ? "s" : ""}
                    </button>
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {displayedSignals.map((s) => {
                    const isActive = s.expiresAt > now;
                    const isExpired = !isActive;
                    return (
                      <Link key={s.signalId} href={`/genius/signal/${s.signalId}`} className={`card flex items-center justify-between hover:border-genius-300 active:bg-slate-50 transition-colors ${isExpired ? "opacity-70" : ""}`}>
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            {s.sport} &middot; Signal #{truncateAddress(s.signalId)}
                          </p>
                          <p className="text-xs text-slate-500 mt-1">
                            Fee: {formatBps(s.maxPriceBps)} &middot; SLA: {formatBps(s.slaMultiplierBps)} &middot; Max: ${formatUsdc(s.maxNotional)}
                            {isActive && (
                              <> &middot; Expires: {new Date(Number(s.expiresAt) * 1000).toLocaleString()}</>
                            )}
                            {isExpired && (
                              <> &middot; Expired: {new Date(Number(s.expiresAt) * 1000).toLocaleDateString()}</>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          {verifiedMap.has(s.signalId.toString()) && !verifiedMap.get(s.signalId.toString()) && (
                            <span
                              className="rounded-full px-3 py-1 text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200 cursor-help"
                              title="A miner couldn't confirm your lines were available at sportsbooks when you created this signal. Your signal still works; this just means the pre-check was skipped (usually because a miner was offline)."
                            >
                              Lines Not Checked
                            </span>
                          )}
                          {isActive ? (
                            <span className="rounded-full px-3 py-1 text-xs font-medium bg-green-100 text-green-600 border border-green-200">
                              Active
                            </span>
                          ) : (
                            <span className="rounded-full px-3 py-1 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">
                              Expired
                            </span>
                          )}
                          <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
      </section>

      {/* Active Relationships & Early Exit */}
      <RelationshipsSection address={address} />

      {/* History */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-slate-900">
            History
          </h2>
          {audits.length > 0 && (
            <Link href="/genius/track-record" className="text-sm text-genius-500 hover:text-genius-600 transition-colors">
              View Full Track Record
            </Link>
          )}
        </div>
        {auditsLoading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="card">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="h-4 bg-slate-200 rounded w-44 mb-2" />
                    <div className="h-3 bg-slate-100 rounded w-64" />
                  </div>
                  <div className="h-6 bg-slate-100 rounded-full w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : audits.length === 0 ? (
          <div className="card text-center py-8">
            <p className="text-slate-500 mb-3">
              No settled cycles yet.
            </p>
            <p className="text-xs text-slate-400">
              Every 10 signals between you and a buyer are settled automatically by validator consensus.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {audits.slice(0, 5).map((a) => (
              <div key={`${a.genius}-${a.idiot}-${a.cycle.toString()}`} className="card">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Cycle {a.cycle.toString()} &middot; {truncateAddress(a.idiot)}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-xs text-slate-500">
                      <span>Earned: ${formatUsdc(a.trancheA)}</span>
                      {a.trancheB > 0n && <span>Bonus: ${formatUsdc(a.trancheB)}</span>}
                      {a.protocolFee > 0n && <span>Fee: ${formatUsdc(a.protocolFee)}</span>}
                      {a.isEarlyExit && <span className="text-amber-500">Early Exit</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    {a.isEarlyExit ? (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-yellow-100 text-yellow-700">Early Exit</span>
                    ) : a.qualityScore >= 0n ? (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-green-100 text-green-700">Favorable</span>
                    ) : (
                      <span className="rounded-full px-2 py-0.5 text-xs bg-red-100 text-red-700">Unfavorable</span>
                    )}
                    <span className={`text-sm font-bold ${a.qualityScore >= 0n ? "text-green-600" : "text-red-500"}`}>
                      {a.qualityScore >= 0n ? "+" : "-"}${formatUsdc(a.qualityScore < 0n ? -a.qualityScore : a.qualityScore)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {audits.length > 5 && (
              <Link href="/genius/track-record" className="block text-center text-sm text-genius-500 hover:text-genius-600 py-2">
                View all {audits.length} settled cycles &rarr;
              </Link>
            )}
          </div>
        )}
      </section>
      <OnboardingChecklist role="genius" position="bottom" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships & Early Exit Section
// ---------------------------------------------------------------------------

function RelationshipsSection({ address }: { address: string | undefined }) {
  const { relationships, loading: relLoading } = useActiveRelationships(address, "genius");
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
            No active buyer relationships. Relationships form when an Idiot purchases one of your signals.
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
                      Buyer: {truncateAddress(rel.idiot)}
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
                      <span className="rounded-full px-3 py-1 text-xs font-medium bg-genius-100 text-genius-600 border border-genius-200">
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
                        className="bg-genius-500 h-1.5 rounded-full transition-all"
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
