"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import QualityScore from "@/components/QualityScore";
import { useCollateral, useDepositCollateral, useWithdrawCollateral, useWalletUsdcBalance, useEarlyExit, humanizeError } from "@/lib/hooks";
import { useActiveSignals } from "@/lib/hooks/useSignals";
import { useAuditHistory } from "@/lib/hooks/useAuditHistory";
import { useSettledSignals, getSavedSignals } from "@/lib/hooks/useSettledSignals";
import { useActiveRelationships, type ActiveRelationship } from "@/lib/hooks/useActiveRelationships";
import { formatUsdc, parseUsdc, formatBps, truncateAddress } from "@/lib/types";

export default function GeniusDashboard() {
  const { isConnected, address } = useAccount();
  const { deposit, locked, available, loading, refresh: refreshCollateral } = useCollateral(address);
  const { balance: walletUsdc, loading: walletUsdcLoading, refresh: refreshWalletUsdc } = useWalletUsdcBalance(address);
  const { deposit: depositCollateral, loading: depositLoading } = useDepositCollateral();
  const { withdraw: withdrawCollateral, loading: withdrawLoading } = useWithdrawCollateral();
  const { signals: mySignals, loading: signalsLoading } = useActiveSignals(undefined, address, true);
  const { audits, loading: auditsLoading, aggregateQualityScore } = useAuditHistory(address);
  const { signals: settledSignals } = useSettledSignals(address);

  // Map signal IDs to their minerVerified status from localStorage
  const verifiedMap = useMemo(() => {
    const saved = getSavedSignals(address);
    const map = new Map<string, boolean>();
    for (const s of saved) map.set(s.signalId, s.minerVerified === true);
    return map;
  }, [address]);

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
        setTxSuccess("USDC approved! Click Deposit again to complete.");
        return;
      }
      setDepositAmount("");
      setTxSuccess(`Deposited ${depositAmount} USDC collateral`);
      refreshCollateral();
      refreshWalletUsdc();
    } catch (err) {
      setTxError(humanizeError(err, "Deposit failed"));
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
      refreshCollateral();
      refreshWalletUsdc();
    } catch (err) {
      setTxError(humanizeError(err, "Withdraw failed"));
    }
  };

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-16 h-16 rounded-full bg-genius-100 flex items-center justify-center mb-6">
          <svg className="w-8 h-8 text-genius-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Genius Dashboard</h1>
        <p className="text-slate-500 mb-6">
          Connect your wallet to sell signals and manage your track record.
        </p>
        <p className="text-xs text-slate-400">
          Use the Connect button in the top right corner.
        </p>
      </div>
    );
  }

  return (
    <div>
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Wallet USDC
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {walletUsdcLoading ? "..." : `$${formatUsdc(walletUsdc)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">Available to deposit</p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Collateral
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">
            {loading ? "..." : `$${formatUsdc(deposit)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">USDC deposited</p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Locked
          </p>
          <p className="text-2xl font-bold text-genius-500 mt-2">
            {loading ? "..." : `$${formatUsdc(locked)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">Backing signals</p>
        </div>

        <div className="card">
          <p className="text-xs text-slate-500 uppercase tracking-wide">
            Available
          </p>
          <p className="text-2xl font-bold text-green-600 mt-2">
            {loading ? "..." : `$${formatUsdc(available)}`}
          </p>
          <p className="text-xs text-slate-500 mt-1">Free to withdraw</p>
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

      {/* My Signals */}
      <section className="mb-8">
        {(() => {
          const now = BigInt(Math.floor(Date.now() / 1000));
          const activeSignals = mySignals.filter((s) => s.expiresAt > now);
          const expiredSignals = mySignals.filter((s) => s.expiresAt <= now);
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
                          {!verifiedMap.get(s.signalId.toString()) && (
                            <span className="rounded-full px-3 py-1 text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
                              Unverified
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

      {/* Audit History */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold text-slate-900 mb-4">
          Audit History
        </h2>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="pb-3 font-medium">Cycle</th>
                <th className="pb-3 font-medium">Idiot</th>
                <th className="pb-3 font-medium">QS Delta</th>
                <th className="pb-3 font-medium">Outcome</th>
                <th className="pb-3 font-medium">Earned</th>
                <th className="pb-3 font-medium">Fee</th>
                <th className="pb-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {auditsLoading ? (
                <>
                  {[1, 2, 3].map((i) => (
                    <tr key={i} className="border-b border-slate-100 animate-pulse">
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-8" /></td>
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-20" /></td>
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-12" /></td>
                      <td className="py-3"><div className="h-5 bg-slate-100 rounded-full w-16" /></td>
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-14" /></td>
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-10" /></td>
                      <td className="py-3"><div className="h-4 bg-slate-100 rounded w-20" /></td>
                    </tr>
                  ))}
                </>
              ) : audits.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-slate-500 py-8">
                    No audit history yet. Audits happen automatically after every 10
                    signals settle between you and a buyer.
                  </td>
                </tr>
              ) : (
                audits.map((a, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-3">{a.cycle.toString()}</td>
                    <td className="py-3">{truncateAddress(a.idiot)}</td>
                    <td className="py-3">
                      <span className={Number(a.qualityScore) >= 0 ? "text-green-600" : "text-red-500"}>
                        {Number(a.qualityScore) >= 0 ? "+" : ""}{a.qualityScore.toString()}
                      </span>
                    </td>
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
                      {a.protocolFee > 0n ? (
                        <span className="text-slate-500">${formatUsdc(a.protocolFee)}</span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                    <td className="py-3 text-slate-500">Block {a.blockNumber}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Settlement History */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-slate-900">
            Settlement History
          </h2>
          <Link href="/genius/track-record" className="text-sm text-genius-500 hover:text-genius-600 transition-colors">
            View Full Track Record
          </Link>
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
              No settled audit sets yet.
            </p>
            <p className="text-xs text-slate-400">
              Settlements occur after 10 signals with each buyer are resolved by validator consensus.
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
                    <div className="flex gap-4 mt-1 text-xs text-slate-500">
                      <span>Tranche A: ${formatUsdc(a.trancheA)}</span>
                      {a.trancheB > 0n && <span>Tranche B: ${formatUsdc(a.trancheB)}</span>}
                      {a.isEarlyExit && <span className="text-amber-500">Early Exit</span>}
                    </div>
                  </div>
                  <span className={`text-sm font-bold ${a.qualityScore >= 0n ? "text-green-600" : "text-red-500"}`}>
                    {a.qualityScore >= 0n ? "+" : "-"}${formatUsdc(a.qualityScore < 0n ? -a.qualityScore : a.qualityScore)}
                  </span>
                </div>
              </div>
            ))}
            {audits.length > 5 && (
              <Link href="/genius/track-record" className="block text-center text-sm text-genius-500 hover:text-genius-600 py-2">
                View all {audits.length} settlements &rarr;
              </Link>
            )}
          </div>
        )}
      </section>

      {/* Active Relationships & Early Exit */}
      <RelationshipsSection address={address} />

      {/* Collateral Management */}
      <section>
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
