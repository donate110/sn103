"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useWalletClient } from "wagmi";
import { useSignal, usePurchaseSignal, useSignalNotionalFilled } from "@/lib/hooks";
import { getValidatorClient, getValidatorClients, getMinerClient } from "@/lib/api";
import { decrypt, fromHex, bigIntToKey, reconstructSecret } from "@/lib/crypto";
import type { ShamirShare } from "@/lib/crypto";
import { useActiveSignals } from "@/lib/hooks/useSignals";
import { useAuditHistory } from "@/lib/hooks/useAuditHistory";
import QualityScore from "@/components/QualityScore";
import {
  SignalStatus,
  signalStatusLabel,
  formatBps,
  formatUsdc,
  truncateAddress,
} from "@/lib/types";
import type { CandidateLine } from "@/lib/api";
import { decoyLineToCandidateLine, parseLine, formatLine } from "@/lib/odds";
import { getSportsbookPrefs, setSportsbookPrefs, savePurchasedSignal } from "@/lib/preferences";

type PurchaseStep =
  | "idle"
  | "checking_lines"
  | "purchasing_validator"
  | "purchasing_chain"
  | "collecting_shares"
  | "decrypting"
  | "complete"
  | "error";

export default function PurchaseSignal() {
  const params = useParams();
  const router = useRouter();
  const { isConnected, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  let signalId: bigint | undefined;
  try {
    signalId = params.id ? BigInt(params.id as string) : undefined;
  } catch {
    // Invalid signal ID in URL — will show "not found" via useSignal
  }
  const { signal, loading: signalLoading, error: signalError } =
    useSignal(signalId);
  const { purchase, loading: purchaseLoading, error: purchaseError } =
    usePurchaseSignal();
  const { filled: notionalFilled } = useSignalNotionalFilled(signalId?.toString());

  // Fetch genius stats for sidebar
  const geniusAddress = signal?.genius;
  const { signals: geniusSignals } = useActiveSignals(
    undefined,
    geniusAddress,
  );
  const { audits: geniusAudits, aggregateQualityScore } =
    useAuditHistory(geniusAddress);

  const [notional, setNotional] = useState("");
  const [selectedSportsbook, setSelectedSportsbook] = useState("");
  const [step, setStep] = useState<PurchaseStep>("idle");
  const [stepError, setStepError] = useState<string | null>(null);
  const [decryptedPick, setDecryptedPick] = useState<{
    realIndex: number;
    pick: string;
  } | null>(null);
  const [availableIndices, setAvailableIndices] = useState<number[]>([]);
  const [marketOdds, setMarketOdds] = useState<number | null>(null);
  const purchaseInFlight = useRef(false);
  const purchaseBtnRef = useRef<HTMLButtonElement>(null);
  const [purchaseBtnVisible, setPurchaseBtnVisible] = useState(false);

  // Hide sticky mobile bar when the form submit button scrolls into view
  useEffect(() => {
    const el = purchaseBtnRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setPurchaseBtnVisible(entry.isIntersecting),
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [step]);

  // Sportsbook preferences
  const [savedPrefs, setSavedPrefs] = useState<string[]>([]);
  const [editingPrefs, setEditingPrefs] = useState(false);
  const [pendingPrefs, setPendingPrefs] = useState<string[]>([]);

  // Load sportsbook prefs from localStorage
  const sportsbooks = signal?.availableSportsbooks;
  useEffect(() => {
    const prefs = getSportsbookPrefs(address);
    setSavedPrefs(prefs);
  }, [address]);

  // Auto-select sportsbook from prefs or first available
  useEffect(() => {
    if (!sportsbooks || sportsbooks.length === 0) return;
    if (selectedSportsbook) return;

    // Try saved prefs first (in order)
    for (const pref of savedPrefs) {
      if (sportsbooks.includes(pref)) {
        setSelectedSportsbook(pref);
        return;
      }
    }
    // Fall back to first available
    setSelectedSportsbook(sportsbooks[0]);
  }, [sportsbooks, selectedSportsbook, savedPrefs]);

  const togglePendingPref = (book: string) => {
    setPendingPrefs((prev) =>
      prev.includes(book)
        ? prev.filter((b) => b !== book)
        : [...prev, book],
    );
  };

  const savePendingPrefs = () => {
    if (address) setSportsbookPrefs(address, pendingPrefs);
    setSavedPrefs(pendingPrefs);
    setEditingPrefs(false);
    // Auto-select first preferred that's available
    if (sportsbooks) {
      for (const pref of pendingPrefs) {
        if (sportsbooks.includes(pref)) {
          setSelectedSportsbook(pref);
          setMarketOdds(null);
          break;
        }
      }
    }
  };

  const startEditingPrefs = () => {
    setPendingPrefs(savedPrefs.length > 0 ? [...savedPrefs] : []);
    setEditingPrefs(true);
  };

  if (!isConnected) {
    return (
      <div className="text-center py-20">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Purchase Signal
        </h1>
        <p className="text-slate-500">
          Connect your wallet to purchase this signal.
        </p>
      </div>
    );
  }

  if (signalLoading) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Loading signal data...</p>
      </div>
    );
  }

  if (signalError) {
    return (
      <div className="text-center py-20">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Signal Not Found
        </h1>
        <p className="text-slate-500 mb-8">{signalError}</p>
        <button onClick={() => router.push("/idiot")} className="btn-primary">
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (!signal) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-500">Signal not found</p>
      </div>
    );
  }

  const expiresDate = new Date(Number(signal.expiresAt) * 1000);
  const isExpired = expiresDate < new Date();
  const isActive = signal.status === SignalStatus.Active && !isExpired;

  // Build ordered list of sportsbooks to try: selected first, then remaining prefs
  const getSportsbooksToTry = (): string[] => {
    const toTry: string[] = [selectedSportsbook];
    for (const pref of savedPrefs) {
      if (pref !== selectedSportsbook && signal.availableSportsbooks.includes(pref)) {
        toTry.push(pref);
      }
    }
    return toTry;
  };

  const handlePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signalId || !selectedSportsbook) return;
    if (purchaseInFlight.current) return;
    purchaseInFlight.current = true;

    const buyerAddress = address;
    if (!buyerAddress) {
      setStepError("Wallet not connected. Please connect your wallet and try again.");
      setStep("idle");
      purchaseInFlight.current = false;
      return;
    }

    setStepError(null);

    try {
      // Step 1: Check line availability with miner — auto-retry with preferred sportsbooks
      setStep("checking_lines");

      const miner = getMinerClient();
      const candidateLines: CandidateLine[] = signal.decoyLines.map(
        (raw, i) =>
          decoyLineToCandidateLine(
            raw,
            i + 1,
            signal.sport,
            params.id as string,
          ),
      );

      const sportsbooksToTry = getSportsbooksToTry();
      let checkResult: Awaited<ReturnType<typeof miner.checkLines>> | null = null;
      let usedSportsbook = selectedSportsbook;

      for (const book of sportsbooksToTry) {
        try {
          const result = await miner.checkLines({ lines: candidateLines });
          if (result.available_indices.length > 0) {
            // At least some lines are available — validators will MPC-check
            // whether the real pick is among them without revealing which is real.
            // Stale decoys don't block the purchase; only a stale real pick does.
            checkResult = result;
            usedSportsbook = book;
            break;
          }
        } catch {
          // Try next sportsbook
          continue;
        }
      }

      if (!checkResult || checkResult.available_indices.length === 0) {
        setStepError(
          savedPrefs.length > 1
            ? `No lines available at any of your preferred sportsbooks (${sportsbooksToTry.join(", ")}). The signal may have gone stale.`
            : "No lines are currently available at this sportsbook. The signal may have gone stale — try another sportsbook or check back later.",
        );
        setStep("idle");
        return;
      }

      // Update selected sportsbook if we fell through to a different one
      if (usedSportsbook !== selectedSportsbook) {
        setSelectedSportsbook(usedSportsbook);
      }
      setAvailableIndices(checkResult.available_indices);

      // Extract best odds from miner response for the used sportsbook
      let bestOdds = 1.91; // fallback
      for (const lineResult of checkResult.results) {
        if (lineResult.available && lineResult.bookmakers) {
          const match = lineResult.bookmakers.find(
            (b) => b.bookmaker.toLowerCase() === usedSportsbook.toLowerCase(),
          );
          if (match && match.odds > 0) {
            bestOdds = match.odds;
            break;
          }
          // If no exact sportsbook match, use any available odds
          if (lineResult.bookmakers.length > 0 && lineResult.bookmakers[0].odds > 0) {
            bestOdds = lineResult.bookmakers[0].odds;
          }
        }
      }
      setMarketOdds(bestOdds);

      // Step 2: Verify availability with validators (MPC check — before payment)
      setStep("purchasing_validator");

      const validators = getValidatorClients();
      const purchaseReq = {
        buyer_address: buyerAddress,
        sportsbook: usedSportsbook,
        available_indices: checkResult.available_indices,
      };

      // First call: validators run MPC to check if real index ∈ available set.
      // In production, they return "payment_required" (available=true) or
      // "unavailable" (available=false). In dev mode, shares may be released
      // immediately.
      const availabilityResults = await Promise.allSettled(
        validators.map((v) => v.purchaseSignal(signalId.toString(), purchaseReq)),
      );

      // Check if any validator confirmed the signal is available
      const anyAvailable = availabilityResults.some(
        (r) => r.status === "fulfilled" && r.value.available,
      );

      if (!anyAvailable) {
        const failedMsg = availabilityResults
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason?.message || "unknown")
          .join("; ");
        setStepError(
          failedMsg || "Signal not available at this sportsbook. Try selecting a different sportsbook.",
        );
        setStep("idle");
        return;
      }

      // Collect any shares already released (dev mode without chain_client)
      const collectedShares: ShamirShare[] = [];
      for (const result of availabilityResults) {
        if (
          result.status === "fulfilled" &&
          result.value.available &&
          result.value.encrypted_key_share &&
          result.value.share_x != null
        ) {
          collectedShares.push({
            x: result.value.share_x,
            y: BigInt("0x" + result.value.encrypted_key_share),
          });
        }
      }

      // Step 3: Execute on-chain purchase (now that MPC confirmed availability)
      setStep("purchasing_chain");

      const notionalNum = parseFloat(notional);
      if (isNaN(notionalNum) || !Number.isFinite(notionalNum) || notionalNum <= 0) {
        setStepError("Invalid notional amount");
        setStep("idle");
        return;
      }
      if (!bestOdds || bestOdds < 1.01) {
        setStepError("Could not determine market odds. Try again.");
        setStep("idle");
        return;
      }

      const notionalBig = BigInt(Math.floor(notionalNum * 1_000_000));
      // Contract uses 6-decimal precision (ODDS_PRECISION = 1e6)
      const oddsBig = BigInt(Math.floor(bestOdds * 1_000_000));

      await purchase(signalId, notionalBig, oddsBig);

      // Step 4: Collect key shares from validators (payment now exists on-chain)
      // Skip if we already got enough shares (dev mode)
      if (collectedShares.length < 7) {
        setStep("collecting_shares");

        const shareResults = await Promise.allSettled(
          validators.map((v) => v.purchaseSignal(signalId.toString(), purchaseReq)),
        );

        for (const result of shareResults) {
          if (
            result.status === "fulfilled" &&
            result.value.available &&
            result.value.encrypted_key_share &&
            result.value.share_x != null
          ) {
            const x = result.value.share_x;
            if (!collectedShares.some((s) => s.x === x)) {
              collectedShares.push({
                x,
                y: BigInt("0x" + result.value.encrypted_key_share),
              });
            }
          }
        }
      }

      // Step 5: Decrypt the signal
      setStep("decrypting");

      if (collectedShares.length > 0) {
        try {
          // Reconstruct AES key from Shamir shares (need ≥ threshold shares)
          const reconstructedBigInt = reconstructSecret(collectedShares);
          const keyBytes = bigIntToKey(reconstructedBigInt);

          // The encrypted blob is stored on-chain as hex-encoded bytes
          // Parse it: format is "iv:ciphertext"
          const blobBytes = signal.encryptedBlob.startsWith("0x")
            ? signal.encryptedBlob.slice(2)
            : signal.encryptedBlob;
          const blobStr = new TextDecoder().decode(fromHex(blobBytes));
          const colonIdx = blobStr.indexOf(":");

          if (colonIdx === -1) {
            throw new Error("Invalid encrypted blob format (missing iv:ciphertext separator)");
          }

          const iv = blobStr.slice(0, colonIdx);
          const ciphertext = blobStr.slice(colonIdx + 1);

          if (!iv || !ciphertext) {
            throw new Error("Invalid encrypted blob format (empty iv or ciphertext)");
          }

          const plaintext = await decrypt(ciphertext, iv, keyBytes);
          let parsed: { realIndex: number; pick: string };
          try {
            parsed = JSON.parse(plaintext);
          } catch {
            throw new Error("Decrypted data is not valid JSON — key may be incorrect");
          }
          if (typeof parsed.realIndex !== "number" || typeof parsed.pick !== "string") {
            throw new Error("Decrypted data missing required fields (realIndex, pick)");
          }
          if (parsed.realIndex < 1 || parsed.realIndex > signal.decoyLines.length) {
            throw new Error(`Invalid realIndex ${parsed.realIndex} (expected 1-${signal.decoyLines.length})`);
          }
          setDecryptedPick(parsed);

          // Persist purchased signal data for recovery
          if (buyerAddress) {
            savePurchasedSignal(buyerAddress, {
              signalId: signalId.toString(),
              realIndex: parsed.realIndex,
              pick: parsed.pick,
              sportsbook: usedSportsbook,
              notional: notional,
              purchasedAt: Math.floor(Date.now() / 1000),
            });

            // Store recovery blob on-chain (non-blocking — localStorage is primary)
            if (walletClient) {
              import("@/lib/contracts").then(({ ADDRESSES }) => {
                if (ADDRESSES.keyRecovery === "0x0000000000000000000000000000000000000000") return;
                Promise.all([
                  import("@wagmi/core"),
                  import("@/app/providers"),
                  import("@/lib/recovery"),
                  import("@/lib/preferences"),
                  import("@/lib/hooks/useSettledSignals"),
                ]).then(([{ waitForTransactionReceipt }, { wagmiConfig }, { storeRecovery }, { getPurchasedSignals }, { getSavedSignals }]) => {
                  storeRecovery(
                    (params) => walletClient.signTypedData(params),
                    walletClient,
                    getSavedSignals(buyerAddress),
                    async (h) => { await waitForTransactionReceipt(wagmiConfig, { hash: h }); },
                    getPurchasedSignals(buyerAddress),
                  ).catch((err: unknown) => {
                    console.warn("[recovery] Failed to store idiot recovery blob:", err);
                  });
                });
              });
            }
          }
        } catch (decryptErr) {
          console.warn("Decryption error:", decryptErr);
          setStepError(
            "Your signal was purchased successfully, but the encryption key is still being reconstructed. The real pick will appear once enough key shares arrive (usually within seconds). Refresh the page to check.",
          );
        }
      }

      setStep("complete");
    } catch (err) {
      setStepError(err instanceof Error ? err.message : "Purchase failed");
      setStep("idle");
    } finally {
      purchaseInFlight.current = false;
    }
  };

  if (step === "complete") {
    return (
      <div className="max-w-2xl mx-auto text-center py-12 sm:py-20">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
          <svg
            className="w-8 h-8 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-4">
          Signal Purchased & Decrypted
        </h1>

        {decryptedPick ? (
          <div className="card text-left mb-8">
            <div className="rounded-lg bg-green-50 border border-green-200 p-4 mb-4">
              <p className="text-xs text-green-600 uppercase tracking-wide mb-1">
                Real Pick (Line #{decryptedPick.realIndex})
              </p>
              <p className="text-lg font-bold text-green-800">
                {decryptedPick.pick}
              </p>
            </div>
            <CompletionDecoyLines
              decoyLines={signal.decoyLines}
              realIndex={decryptedPick.realIndex}
            />
          </div>
        ) : (
          <div className="card text-left mb-8">
            <CompletionDecoyLines
              decoyLines={signal.decoyLines}
              realIndex={null}
              label="Lines (decryption key pending)"
            />
          </div>
        )}

        <button
          onClick={() => router.push("/idiot")}
          className="btn-primary"
        >
          Back to Dashboard
        </button>
      </div>
    );
  }

  const isProcessing =
    step === "checking_lines" ||
    step === "purchasing_validator" ||
    step === "purchasing_chain" ||
    step === "collecting_shares" ||
    step === "decrypting";

  const stepLabel: Record<string, string> = {
    checking_lines: "Checking line availability...",
    purchasing_validator: "Verifying signal availability with validators...",
    purchasing_chain: "Processing on-chain purchase... (10\u201330s)",
    collecting_shares: "Collecting key shares from validators...",
    decrypting: "Decrypting your signal...",
  };

  return (
    <div className="max-w-3xl mx-auto pb-20 md:pb-0">
      <button
        onClick={() => router.push("/idiot")}
        className="text-sm text-slate-500 hover:text-slate-900 mb-6 transition-colors"
      >
        &larr; Back to Dashboard
      </button>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Signal Info */}
        <div className="md:col-span-2 space-y-6">
          <div className="card">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">
                  Signal #{truncateAddress(String(params.id))}
                </h1>
                <p className="text-sm text-slate-500 mt-1">
                  by {truncateAddress(signal.genius)}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  isActive
                    ? "bg-green-100 text-green-600 border border-green-200"
                    : "bg-slate-100 text-slate-500 border border-slate-200"
                }`}
              >
                {isActive ? "Active" : signalStatusLabel(signal.status)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wide">
                  Sport
                </p>
                <p className="text-sm text-slate-900 font-medium mt-1">
                  {signal.sport}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wide">
                  Signal Fee
                </p>
                <p className="text-sm text-slate-900 font-medium mt-1">
                  {formatBps(signal.maxPriceBps)} of notional
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  ${((100 * Number(signal.maxPriceBps)) / 10_000).toFixed(2)} per $100
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wide">
                  Genius Skin in Game
                </p>
                <p className="text-sm text-slate-900 font-medium mt-1">
                  {formatBps(signal.slaMultiplierBps)}
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Genius has {formatBps(signal.slaMultiplierBps)} of your notional locked as collateral,
                  settled based on audited performance across a cycle of signals.
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wide">
                  Expires
                </p>
                <p
                  className={`text-sm font-medium mt-1 ${
                    isExpired ? "text-red-600" : "text-slate-900"
                  }`}
                >
                  {expiresDate.toLocaleString()}
                </p>
              </div>
            </div>

            {/* Lines hidden pre-purchase — idiot can't distinguish real from decoy */}
            <p className="text-xs text-slate-400 italic">
              {signal.decoyLines.length} encrypted lines &mdash; the real pick is revealed after purchase.
            </p>
          </div>

          {signal.availableSportsbooks.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-slate-500 uppercase tracking-wide">
                  {editingPrefs ? "Set Sportsbook Preferences" : "Sportsbook"}
                </p>
                {!editingPrefs && savedPrefs.length > 0 && (
                  <button
                    type="button"
                    onClick={startEditingPrefs}
                    className="text-xs text-idiot-500 hover:text-idiot-600 transition-colors"
                  >
                    Change
                  </button>
                )}
              </div>

              {editingPrefs ? (
                <div>
                  <p className="text-xs text-slate-400 mb-2">
                    Select your preferred sportsbooks in order. On purchase, Djinn will auto-try the next if a line check fails.
                  </p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {signal.availableSportsbooks.map((book) => {
                      const idx = pendingPrefs.indexOf(book);
                      const isSelected = idx !== -1;
                      return (
                        <button
                          key={book}
                          type="button"
                          onClick={() => togglePendingPref(book)}
                          className={`rounded-lg px-3 py-1.5 text-sm transition-colors relative ${
                            isSelected
                              ? "bg-idiot-500 text-white"
                              : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                          }`}
                        >
                          {isSelected && (
                            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-900 text-white text-[10px] flex items-center justify-center">
                              {idx + 1}
                            </span>
                          )}
                          {book}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={savePendingPrefs}
                      disabled={pendingPrefs.length === 0}
                      className="btn-primary text-xs px-3 py-1.5"
                    >
                      Save Preferences
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingPrefs(false)}
                      className="btn-secondary text-xs px-3 py-1.5"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : savedPrefs.length === 0 && signal.availableSportsbooks.length > 1 ? (
                <div>
                  <p className="text-xs text-slate-400 mb-2">
                    No sportsbook preferences saved. Select your preferred sportsbooks for faster purchasing.
                  </p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {signal.availableSportsbooks.map((book) => (
                      <button
                        key={book}
                        type="button"
                        onClick={() => { setSelectedSportsbook(book); setMarketOdds(null); setAvailableIndices([]); }}
                        className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                          selectedSportsbook === book
                            ? "bg-idiot-500 text-white"
                            : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                        }`}
                      >
                        {book}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={startEditingPrefs}
                    className="text-xs text-idiot-500 hover:text-idiot-600 transition-colors"
                  >
                    Set preferences for auto-retry
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {signal.availableSportsbooks.map((book) => (
                    <button
                      key={book}
                      type="button"
                      onClick={() => { setSelectedSportsbook(book); setMarketOdds(null); setAvailableIndices([]); }}
                      className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                        selectedSportsbook === book
                          ? "bg-idiot-500 text-white"
                          : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                      }`}
                    >
                      {book}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Purchase Panel */}
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Purchase Signal
            </h2>

            {!isActive ? (
              <p className="text-sm text-slate-500">
                This signal is no longer available for purchase.
              </p>
            ) : (
              <form onSubmit={handlePurchase} className="space-y-4">
                <div>
                  <label htmlFor="notional" className="label">Notional (USDC)</label>
                  {signal.maxNotional > 0n && (
                    <div className="mb-2">
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>${formatUsdc(notionalFilled)} filled</span>
                        <span>${formatUsdc(signal.maxNotional)} capacity</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div
                          className="bg-idiot-500 h-2 rounded-full transition-all"
                          style={{ width: `${Math.min(100, Number(notionalFilled * 100n / signal.maxNotional))}%` }}
                        />
                      </div>
                      {notionalFilled >= signal.maxNotional && (
                        <p className="text-xs text-red-500 mt-1 font-medium">This signal is fully filled</p>
                      )}
                    </div>
                  )}
                  <input
                    id="notional"
                    type="number"
                    value={notional}
                    onChange={(e) => setNotional(e.target.value)}
                    placeholder="100.00"
                    min={signal.minNotional > 0n ? Number(signal.minNotional) / 1e6 : 0.01}
                    step="0.01"
                    max={signal.maxNotional > 0n ? Number(signal.maxNotional - notionalFilled) / 1e6 : undefined}
                    className="input"
                    required
                    disabled={signal.maxNotional > 0n && notionalFilled >= signal.maxNotional}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Your notional amount. This determines the signal fee and the Genius&apos;s collateral commitment.
                    {signal.maxNotional > 0n && notionalFilled < signal.maxNotional && (
                      <span className="block mt-0.5 text-slate-400">
                        Remaining: ${formatUsdc(signal.maxNotional - notionalFilled)} of ${formatUsdc(signal.maxNotional)}
                      </span>
                    )}
                    {signal.minNotional > 0n && (
                      <span className="block mt-0.5 text-slate-400">
                        Min purchase: ${formatUsdc(signal.minNotional)}
                      </span>
                    )}
                  </p>
                </div>

                {marketOdds && (
                  <div className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Market Odds</p>
                    <p className="text-lg font-bold text-slate-900">{marketOdds.toFixed(2)}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Live odds from {selectedSportsbook || "sportsbook"} via miner network
                    </p>
                  </div>
                )}

                {notional && (
                  <div className="rounded-lg bg-slate-50 p-3 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">You pay (fee)</span>
                      <span className="text-slate-900 font-medium">
                        $
                        {(
                          (Number(notional) * Number(signal.maxPriceBps)) /
                          10_000
                        ).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">
                        Genius collateral locked
                      </span>
                      <span className="text-slate-900 font-medium">
                        $
                        {(
                          (Number(notional) *
                            Number(signal.slaMultiplierBps)) /
                          10_000
                        ).toFixed(2)}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-200">
                      Collateral is settled based on the Genius&apos;s audited quality score across a cycle of signals, not on any single pick.
                      {" "}Any Djinn Credits in your account are applied automatically to reduce the USDC portion of the fee.
                    </p>
                  </div>
                )}

                {(purchaseError || stepError) && (
                  <div className="rounded-lg bg-red-50 border border-red-200 p-3" role="alert">
                    <p className="text-xs text-red-600">
                      {purchaseError || stepError}
                    </p>
                  </div>
                )}

                {isProcessing && (
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-3" aria-live="polite">
                    <p className="text-xs text-blue-600">
                      {stepLabel[step] ?? "Processing..."}
                    </p>
                  </div>
                )}

                <button
                  ref={purchaseBtnRef}
                  type="submit"
                  disabled={
                    isProcessing || purchaseLoading || !selectedSportsbook
                  }
                  className="btn-primary w-full py-3"
                >
                  {isProcessing
                    ? "Processing..."
                    : "Purchase Signal"}
                </button>
              </form>
            )}
          </div>

          {/* Genius info sidebar */}
          <div className="card">
            <h3 className="text-sm font-medium text-slate-500 mb-3">
              Genius Stats
            </h3>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-slate-500">Quality Score</p>
                <div className="mt-1">
                  <QualityScore score={Number(aggregateQualityScore)} size="sm" />
                </div>
              </div>
              <div>
                <p className="text-xs text-slate-500">Total Signals</p>
                <p className="text-sm text-slate-900 font-medium">
                  {geniusSignals.length}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Audit Count</p>
                <p className="text-sm text-slate-900 font-medium">
                  {geniusAudits.length}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sticky mobile purchase bar — hidden when form submit button is in view */}
      {isActive && !isProcessing && !purchaseBtnVisible && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden bg-white/95 backdrop-blur-sm border-t border-slate-200 px-4 py-3 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-10">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm">
              {notional ? (
                <span className="text-slate-900 font-medium">
                  Fee: ${((Number(notional) * Number(signal.maxPriceBps)) / 10_000).toFixed(2)}
                </span>
              ) : (
                <span className="text-slate-500">Enter notional above</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                // Scroll to purchase form
                document.getElementById("notional")?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              className="btn-idiot whitespace-nowrap"
            >
              Purchase Signal
            </button>
          </div>
        </div>
      )}

      {isProcessing && (
        <div className="fixed bottom-0 left-0 right-0 md:hidden bg-blue-50 border-t border-blue-200 px-4 py-3 z-10">
          <p className="text-xs text-blue-600 text-center">
            {stepLabel[step] ?? "Processing..."}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible decoy lines for the completion screen
// ---------------------------------------------------------------------------
function CompletionDecoyLines({
  decoyLines,
  realIndex,
  label,
}: {
  decoyLines: string[];
  realIndex: number | null;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-sm font-medium text-slate-500 mb-2 hover:text-slate-700 transition-colors"
      >
        <span>{label || `All ${decoyLines.length} Lines`}</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="space-y-1">
          {decoyLines.map((raw, i) => {
            const structured = parseLine(raw);
            const display = structured ? formatLine(structured) : raw;
            const isReal = realIndex !== null && i + 1 === realIndex;
            return (
              <p
                key={i}
                className={`text-sm font-mono rounded px-3 py-2 ${
                  isReal
                    ? "bg-green-100 text-green-800 font-bold"
                    : "bg-slate-50 text-slate-500"
                }`}
              >
                {i + 1}. {display}
                {isReal && " \u2190 REAL"}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
