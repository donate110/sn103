"use client";

import { useCallback, useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useSignal, useCancelSignal, useSignalPurchases, useSignalNotionalFilled, humanizeError } from "@/lib/hooks";
import { invalidateSignalCache } from "@/lib/events";
import { useEncryptedSignals } from "@/lib/hooks/useEncryptedSignals";
import { SignalStatus, formatUsdc, formatBps, truncateAddress } from "@/lib/types";

export default function GeniusSignalDetail() {
  const params = useParams();
  const router = useRouter();
  const { address } = useAccount();
  const signalId = params.id as string;

  const { signal, loading, error } = useSignal(
    signalId ? BigInt(signalId) : undefined
  );
  const { cancelSignal, loading: cancelLoading, error: cancelError } = useCancelSignal();
  const { purchases, totalNotional, loading: purchasesLoading } = useSignalPurchases(signalId);
  const { filled: notionalFilled } = useSignalNotionalFilled(signalId);

  const [showConfirmCancel, setShowConfirmCancel] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Find local private data for this signal (real pick, decoys, etc.)
  const {
    signals: allSavedSignals,
    locked: savedLocked,
    unlock: unlockSaved,
    save: saveSavedSignals,
  } = useEncryptedSignals();

  const [localCleared, setLocalCleared] = useState(false);
  const savedData = useMemo(() => {
    if (localCleared || !address) return null;
    return allSavedSignals.find((s) => s.signalId === signalId) ?? null;
  }, [allSavedSignals, address, signalId, localCleared]);

  const clearLocalData = useCallback(async () => {
    if (!address) return;
    const filtered = allSavedSignals.filter((s) => s.signalId !== signalId);
    await saveSavedSignals(filtered);
    setLocalCleared(true);
  }, [address, allSavedSignals, signalId, saveSavedSignals]);

  const isOwner = signal && address
    ? signal.genius.toLowerCase() === address.toLowerCase()
    : false;

  const isActive = signal?.status === SignalStatus.Active;
  const isExpired = signal
    ? Number(signal.expiresAt) * 1000 < Date.now()
    : false;
  const isCancelled = signal?.status === SignalStatus.Cancelled;
  const canCancel = isOwner && isActive && !isExpired && !isCancelled;
  const hasPurchases = purchases.length > 0;

  const handleCancel = async () => {
    setActionError(null);
    try {
      await cancelSignal(BigInt(signalId));
      invalidateSignalCache(address);
      setCancelSuccess(true);
      setShowConfirmCancel(false);
    } catch (err) {
      setActionError(humanizeError(err, "Failed to cancel signal"));
    }
  };

  const handleCancelAndEdit = async () => {
    setActionError(null);
    try {
      await cancelSignal(BigInt(signalId));
      invalidateSignalCache(address);
      router.push("/genius/signal/new");
    } catch (err) {
      setActionError(humanizeError(err, "Failed to cancel signal"));
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <p className="text-center text-slate-500">Loading signal...</p>
      </div>
    );
  }

  if (error || !signal) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <p className="text-center text-red-500">
          {error || "Signal not found"}
        </p>
        <div className="text-center mt-4">
          <Link href="/genius" className="text-sm text-genius-500 hover:text-genius-600">
            &larr; Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const statusLabel =
    cancelSuccess ? "Cancelled" :
    signal.status === SignalStatus.Cancelled ? "Cancelled" :
    signal.status === SignalStatus.Settled ? "Settled" :
    isExpired ? "Expired" : "Active";

  const statusColor =
    statusLabel === "Active" ? "bg-green-100 text-green-600 border-green-200" :
    statusLabel === "Expired" ? "bg-slate-100 text-slate-500 border-slate-200" :
    statusLabel === "Cancelled" ? "bg-red-100 text-red-500 border-red-200" :
    "bg-slate-100 text-slate-500 border-slate-200";

  return (
    <div className="max-w-3xl mx-auto">
      <Link
        href="/genius"
        className="text-sm text-slate-500 hover:text-slate-700 transition-colors mb-6 inline-block"
      >
        &larr; Back to Dashboard
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {signal.sport} Signal
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-mono">
            #{truncateAddress(signalId)}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium border shrink-0 ${statusColor}`}>
          {statusLabel}
        </span>
      </div>

      {/* Action Errors */}
      {(actionError || cancelError) && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 mb-4" role="alert">
          <p className="text-sm text-red-600">{actionError || cancelError}</p>
        </div>
      )}

      {/* Cancel Success */}
      {cancelSuccess && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 mb-4" role="status">
          <p className="text-sm text-green-700">
            Signal cancelled successfully. Your collateral has been released.
          </p>
        </div>
      )}

      {/* Signal Details */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Details</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Fee</p>
            <p className="text-slate-900 font-medium mt-1">{formatBps(signal.maxPriceBps)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">SLA</p>
            <p className="text-slate-900 font-medium mt-1">{formatBps(signal.slaMultiplierBps)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Max Notional</p>
            <p className="text-slate-900 font-medium mt-1">${formatUsdc(signal.maxNotional)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Created</p>
            <p className="text-slate-900 font-medium mt-1">
              {new Date(Number(signal.createdAt) * 1000).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Expires</p>
            <p className={`font-medium mt-1 ${isExpired ? "text-red-500" : "text-slate-900"}`}>
              {new Date(Number(signal.expiresAt) * 1000).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide">Sportsbooks</p>
            <p className="text-slate-900 font-medium mt-1">
              {signal.availableSportsbooks.length > 0
                ? signal.availableSportsbooks.join(", ")
                : "Any"}
            </p>
          </div>
        </div>
      </div>

      {/* Purchases / Notional Taken */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">
          Purchases
          {!purchasesLoading && hasPurchases && (
            <span className="text-sm font-normal text-slate-400 ml-2">
              {purchases.length} purchase{purchases.length !== 1 ? "s" : ""}
            </span>
          )}
        </h2>
        {purchasesLoading ? (
          <p className="text-slate-500 text-sm">Loading...</p>
        ) : !hasPurchases ? (
          <div>
            <p className="text-slate-500 text-sm">
              No purchases yet. The full notional (${formatUsdc(signal.maxNotional)}) is still available.
            </p>
            {signal.minNotional > 0n && (
              <p className="text-xs text-slate-400 mt-1">Min purchase: ${formatUsdc(signal.minNotional)}</p>
            )}
          </div>
        ) : (
          <>
            <div className="mb-4">
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-slate-500">Notional filled</span>
                <span className="font-medium text-slate-900">
                  ${formatUsdc(notionalFilled)} / ${formatUsdc(signal.maxNotional)}
                </span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-2">
                <div
                  className="bg-genius-500 h-2 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, signal.maxNotional > 0n
                      ? Number((notionalFilled * 100n) / signal.maxNotional)
                      : 0)}%`,
                  }}
                />
              </div>
              {signal.minNotional > 0n && (
                <p className="text-xs text-slate-400 mt-1">Min purchase: ${formatUsdc(signal.minNotional)}</p>
              )}
              {notionalFilled >= signal.maxNotional && signal.maxNotional > 0n && (
                <p className="text-xs text-green-600 mt-1 font-medium">Fully filled</p>
              )}
            </div>
            <div className="space-y-2">
              {purchases.map((p) => (
                <div key={p.purchaseId.toString()} className="flex items-center justify-between text-sm py-2 border-b border-slate-100 last:border-0">
                  <span className="text-slate-500">
                    {truncateAddress(p.buyer)}
                  </span>
                  <span className="font-medium text-slate-900">
                    ${formatUsdc(p.notional)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Lines summary */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Lines</h2>
        {signal.lineCount > 0 ? (
          <p className="text-sm text-slate-600">
            {signal.lineCount} lines (privacy-enhanced, stored off-chain with validators)
          </p>
        ) : signal.decoyLines.length > 0 ? (
          <p className="text-sm text-slate-600">
            {signal.decoyLines.length} lines (v1 on-chain)
          </p>
        ) : (
          <p className="text-slate-500 text-sm">No line data available.</p>
        )}
        {savedData ? (
          <div className="rounded-lg bg-genius-50 border border-genius-200 p-3 mt-3">
            <div className="flex items-center gap-1.5 mb-1">
              <svg className="w-3.5 h-3.5 text-genius-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <span className="text-xs text-genius-600 font-medium">Your real pick (only visible to you)</span>
            </div>
            <p className="text-sm font-bold text-genius-800">{savedData.pick}</p>
          </div>
        ) : savedLocked ? (
          <div className="rounded-lg border border-genius-200 bg-genius-50 p-3 mt-3">
            <p className="text-sm text-genius-700">Your signal data is encrypted. Sign to reveal your real pick.</p>
            <button
              type="button"
              onClick={unlockSaved}
              className="mt-2 px-4 py-1.5 text-xs font-medium rounded-lg bg-genius-600 text-white hover:bg-genius-700 transition-colors"
            >
              Unlock Data
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-400 mt-3">
            Local signal data not found. The real pick cannot be shown.
            This may happen if the signal was created in a different browser session.
          </p>
        )}
      </div>

      {/* Actions */}
      {isOwner && !cancelSuccess && (
        <div className="card">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Actions</h2>
          {isExpired ? (
            <p className="text-slate-500 text-sm">
              This signal has expired. No further actions are available.
              {hasPurchases && (
                <span className="block mt-1">
                  Existing purchases will settle through the normal audit process.
                </span>
              )}
            </p>
          ) : signal.status === SignalStatus.Cancelled ? (
            <p className="text-slate-500 text-sm">
              This signal has been cancelled.
              {hasPurchases && (
                <span className="block mt-1">
                  Existing purchases will settle through the normal audit process.
                </span>
              )}
            </p>
          ) : signal.status === SignalStatus.Settled ? (
            <p className="text-slate-500 text-sm">
              This signal has been settled. No further actions are available.
            </p>
          ) : showConfirmCancel ? (
            <div>
              <p className="text-sm text-slate-700 mb-4">
                {hasPurchases
                  ? `Cancel remaining capacity? ${purchases.length} existing purchase${purchases.length > 1 ? "s" : ""} will still settle through the normal audit process. No new purchases will be accepted.`
                  : "Are you sure you want to cancel this signal? This action is irreversible. Your collateral backing this signal will be released."
                }
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {cancelLoading ? "Cancelling..." : "Confirm Cancel"}
                </button>
                <button
                  type="button"
                  onClick={handleCancelAndEdit}
                  disabled={cancelLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-genius-600 text-white hover:bg-genius-700 disabled:opacity-50 transition-colors"
                >
                  {cancelLoading ? "Cancelling..." : "Cancel & Create New"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfirmCancel(false)}
                  disabled={cancelLoading}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Keep Signal
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowConfirmCancel(true)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
              >
                Cancel Signal
              </button>
              <button
                type="button"
                onClick={() => setShowConfirmCancel(true)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-genius-200 text-genius-600 hover:bg-genius-50 transition-colors"
              >
                Cancel & Edit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

