"use client";

import { useState, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useWalletClient } from "wagmi";
import { useSignal, usePurchaseSignal, useSignalNotionalFilled, useEscrowBalance, useDepositEscrow, useWalletUsdcBalance, humanizeError } from "@/lib/hooks";
import { discoverValidatorClients, resilientCheckLines } from "@/lib/api";
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
  parseUsdc,
  truncateAddress,
} from "@/lib/types";
import type { CandidateLine, BookmakerAvailability, CheckResponse } from "@/lib/api";
import { decoyLineToCandidateLine, parseLine, formatLine } from "@/lib/odds";
import { savePurchasedSignal } from "@/lib/preferences";

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
  const { purchase, loading: purchaseLoading, error: purchaseError, txHash } =
    usePurchaseSignal();
  const { filled: notionalFilled } = useSignalNotionalFilled(signalId?.toString());
  const { balance: escrowBalance, refresh: refreshEscrow } = useEscrowBalance(address);
  const { deposit: depositEscrow, loading: depositLoading } = useDepositEscrow();
  const { balance: walletUsdc } = useWalletUsdcBalance(address);
  const [depositAmt, setDepositAmt] = useState("");
  const [depositMsg, setDepositMsg] = useState<string | null>(null);

  // Fetch genius stats for sidebar
  const geniusAddress = signal?.genius;
  const { signals: geniusSignals } = useActiveSignals(
    undefined,
    geniusAddress,
  );
  const { audits: geniusAudits, aggregateQualityScore } =
    useAuditHistory(geniusAddress);

  const [notional, setNotional] = useState("");
  const [step, setStep] = useState<PurchaseStep>("idle");
  const [stepError, setStepError] = useState<string | null>(null);
  const [signalAvailable, setSignalAvailable] = useState<boolean | null>(null); // null = checking
  const [decryptedPick, setDecryptedPick] = useState<{
    realIndex: number;
    pick: string;
  } | null>(null);
  const [availableIndices, setAvailableIndices] = useState<number[]>([]);
  const [marketOdds, setMarketOdds] = useState<number | null>(null);
  const [bestBookmaker, setBestBookmaker] = useState<BookmakerAvailability | null>(null);
  const purchaseInFlight = useRef(false);
  const purchaseBtnRef = useRef<HTMLButtonElement>(null);
  const [purchaseBtnVisible, setPurchaseBtnVisible] = useState(false);
  const checkResultRef = useRef<CheckResponse | null>(null);

  // Check if any validator holds shares for this signal (lightweight GET check)
  useEffect(() => {
    if (!signalId || signalLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const validators = await discoverValidatorClients();
        const probes = await Promise.allSettled(
          validators.map(async (v) => {
            const res = await fetch(`${v.baseUrl}/v1/signal/${signalId}/status`, {
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            return res.json();
          }),
        );
        if (cancelled) return;
        const anyHasShares = probes.some(
          (r) => r.status === "fulfilled" && (r.value as { has_shares?: boolean })?.has_shares,
        );
        setSignalAvailable(anyHasShares);
      } catch {
        if (!cancelled) setSignalAvailable(true); // assume available on error
      }
    })();
    return () => { cancelled = true; };
  }, [signalId, signalLoading]);

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

  const handlePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signalId) return;
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
      // Step 1: Check line availability with miner (any sportsbook)
      setStep("checking_lines");

      const candidateLines: CandidateLine[] = signal.decoyLines.map(
        (raw, i) =>
          decoyLineToCandidateLine(
            raw,
            i + 1,
            signal.sport,
            params.id as string,
          ),
      );

      // Resilient check: retries across ALL discovered validators/miners since
      // most miners have broken Odds API keys and return 0 available lines.
      console.log("[purchase] starting line check for signal", params.id, "with", candidateLines.length, "lines");
      let checkResult: CheckResponse | null = null;
      try {
        const result = await resilientCheckLines({ lines: candidateLines });
        console.log("[purchase] line check complete:", result.available_indices.length, "of", candidateLines.length, "available");
        if (result.available_indices.length > 0) {
          checkResult = result;
        }
      } catch (e) {
        console.log("[purchase] line check FAILED:", String(e).slice(0, 200));
      }

      if (!checkResult || checkResult.available_indices.length === 0) {
        console.log("[purchase] ABORT: no lines available");
        setStepError(
          "No lines are currently available at any sportsbook. The signal may have gone stale — check back later.",
        );
        setStep("idle");
        return;
      }

      // Store full check results so we can find best bookmaker after decryption
      checkResultRef.current = checkResult;
      setAvailableIndices(checkResult.available_indices);
      console.log("[purchase] available_indices:", checkResult.available_indices,
        "total_lines:", candidateLines.length,
        "unavailable:", checkResult.results.filter(r => !r.available).map(r =>
          `${r.index}:${(r as unknown as Record<string, unknown>).unavailable_reason ?? "unknown"}`
        ));

      // Extract best odds across all bookmakers for any available line
      let bestOdds = 1.91; // fallback
      for (const lineResult of checkResult.results) {
        if (lineResult.available && lineResult.bookmakers) {
          for (const bm of lineResult.bookmakers) {
            if (bm.odds > bestOdds) {
              bestOdds = bm.odds;
            }
          }
        }
      }
      setMarketOdds(bestOdds);

      // Step 2: Verify availability with validators (MPC check — before payment)
      setStep("purchasing_validator");

      const validators = await discoverValidatorClients();

      // Sign a purchase message to prove buyer_address ownership
      let buyerSig = "";
      if (walletClient) {
        try {
          buyerSig = await walletClient.signMessage({
            message: `djinn:purchase:${signalId}`,
          });
        } catch {
          // Non-fatal: validator accepts unsigned in dev mode
        }
      }

      const purchaseReq = {
        buyer_address: buyerAddress,
        sportsbook: "",
        available_indices: checkResult.available_indices,
        buyer_signature: buyerSig,
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

      // Log MPC results from each validator for debugging
      console.log("[purchase] MPC results:", availabilityResults.map((r, i) => {
        if (r.status === "fulfilled") {
          const v = r.value;
          const reason = (v as Record<string, unknown>).mpc_failure_reason || "";
          const parts = (v as Record<string, unknown>).mpc_participants || "";
          return `v${i}:${v.available ? "AVAIL" : "UNAVAIL"} (${v.status}/${v.message}) participants=${parts} reason=${reason}`;
        }
        return `v${i}:REJECTED (${r.reason?.message?.slice(0, 80) || "unknown"})`;
      }));

      if (!anyAvailable) {
        const errors = availabilityResults
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason?.message || "unknown");
        // Parse common validator errors into friendly messages
        const allNotFound = errors.length > 0 && errors.every((e) => e.includes("not found"));
        const friendlyMsg = allNotFound
          ? "This signal's encryption keys are not held by any active validator. It may have been created during a network reset and cannot be purchased."
          : "Signal not currently available. The pick may have gone stale — check back later.";
        setStepError(friendlyMsg);
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

      // Fee = notional * maxPriceBps / 10_000
      const feeBig = (notionalBig * BigInt(signal.maxPriceBps)) / 10_000n;
      if (escrowBalance !== undefined && escrowBalance < feeBig) {
        const needed = Number(feeBig) / 1e6;
        const have = Number(escrowBalance) / 1e6;
        setStepError(
          `Insufficient escrow balance: you have $${have.toFixed(2)} but need $${needed.toFixed(2)}. Use the deposit form above.`,
        );
        setStep("idle");
        return;
      }

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

          // Find best bookmaker for the real pick from miner check results
          const storedCheck = checkResultRef.current;
          if (storedCheck) {
            const realLineResult = storedCheck.results.find(
              (r) => r.index === parsed.realIndex,
            );
            if (realLineResult?.bookmakers?.length) {
              const sorted = [...realLineResult.bookmakers].sort(
                (a, b) => b.odds - a.odds,
              );
              setBestBookmaker(sorted[0]);
            }
          }

          // Persist purchased signal data for recovery
          if (buyerAddress) {
            const bestBook = checkResultRef.current?.results
              .find((r) => r.index === parsed.realIndex)
              ?.bookmakers?.sort((a, b) => b.odds - a.odds)?.[0];
            savePurchasedSignal(buyerAddress, {
              signalId: signalId.toString(),
              realIndex: parsed.realIndex,
              pick: parsed.pick,
              sportsbook: bestBook?.bookmaker ?? "",
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
              {bestBookmaker && (
                <p className="text-sm text-green-700 mt-2">
                  Best odds: {bestBookmaker.odds.toFixed(2)} at {bestBookmaker.bookmaker}
                </p>
              )}
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
    purchasing_chain: purchaseLoading && !txHash
      ? "Confirm the transaction in your wallet..."
      : "Waiting for on-chain confirmation... (10\u201330s)",
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
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-slate-900">
                    Signal #{truncateAddress(String(params.id))}
                  </h1>
                  {signal.minNotional > 0n && signal.minNotional === signal.maxNotional && (
                    <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wide">
                      Exclusive
                    </span>
                  )}
                </div>
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
              {signal.decoyLines.length} encrypted lines &mdash; the real signal is revealed after purchase.
            </p>
          </div>

        </div>

        {/* Purchase Panel */}
        <div className="space-y-6">
          <div className="card">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">
              Purchase Signal
            </h2>

            {isActive && escrowBalance !== undefined && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 mb-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500">Your Escrow Balance</p>
                  <p className="text-sm font-medium text-slate-900">
                    ${formatUsdc(escrowBalance)}
                  </p>
                </div>
                {depositMsg && (
                  <p className="text-xs text-green-600 mt-1">{depositMsg}</p>
                )}
                <div className="flex gap-2 mt-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="Amount"
                    className="input flex-1 text-xs py-1.5"
                    value={depositAmt}
                    onChange={(e) => setDepositAmt(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-primary text-xs py-1.5 px-3 whitespace-nowrap"
                    disabled={depositLoading || !depositAmt}
                    onClick={async () => {
                      setDepositMsg(null);
                      try {
                        const result = await depositEscrow(parseUsdc(depositAmt));
                        if (result === "approved") {
                          setDepositMsg("USDC approved! Click Deposit again.");
                          return;
                        }
                        setDepositAmt("");
                        setDepositMsg(`Deposited $${depositAmt}`);
                        refreshEscrow();
                      } catch (err) {
                        setDepositMsg(humanizeError(err, "Deposit failed"));
                      }
                    }}
                  >
                    {depositLoading ? "..." : "Deposit"}
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Wallet: ${formatUsdc(walletUsdc)} USDC
                </p>
              </div>
            )}

            {signalAvailable === null && isActive && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 mb-4">
                <p className="text-xs text-slate-500 animate-pulse">Checking signal availability...</p>
              </div>
            )}

            {signalAvailable === false && isActive && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 mb-4" role="alert">
                <p className="text-sm font-medium text-amber-800 mb-1">Signal Unavailable</p>
                <p className="text-xs text-amber-700">
                  This signal&apos;s encryption keys are not held by any active validator.
                  It may have been created during a network reset and cannot be purchased.
                </p>
              </div>
            )}

            {address && signal.genius && address.toLowerCase() === signal.genius.toLowerCase() && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 mb-4" role="status">
                <p className="text-xs text-amber-700 font-medium">
                  Heads up: this is your own signal.
                </p>
              </div>
            )}

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
                  {(() => {
                    const minVal = signal.minNotional > 0n ? Number(signal.minNotional) / 1e6 : 0.01;
                    const remaining = signal.maxNotional > 0n ? Number(signal.maxNotional - notionalFilled) / 1e6 : 0;
                    const maxVal = signal.maxNotional > 0n ? remaining : undefined;
                    const hasRange = maxVal !== undefined && maxVal > minVal;
                    const isFull = signal.maxNotional > 0n && notionalFilled >= signal.maxNotional;
                    return (
                      <>
                        {hasRange && (
                          <div className="mb-2">
                            <input
                              type="range"
                              min={minVal}
                              max={maxVal}
                              step={0.01}
                              value={notional || minVal}
                              onChange={(e) => setNotional(e.target.value)}
                              className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-idiot-500"
                              disabled={isFull}
                            />
                          </div>
                        )}
                        <div className="flex gap-2 mb-2">
                          {maxVal !== undefined && maxVal === minVal ? (
                            <button
                              type="button"
                              onClick={() => setNotional(String(maxVal))}
                              disabled={isFull}
                              className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                                notional === String(maxVal)
                                  ? "border-idiot-300 bg-idiot-50 text-idiot-700"
                                  : "border-slate-200 text-slate-500 hover:border-idiot-300 hover:text-idiot-600"
                              }`}
                            >
                              ${maxVal.toFixed(2)}
                            </button>
                          ) : (
                            <>
                              {minVal > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setNotional(String(minVal))}
                                  disabled={isFull}
                                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                                    notional === String(minVal)
                                      ? "border-idiot-300 bg-idiot-50 text-idiot-700"
                                      : "border-slate-200 text-slate-500 hover:border-idiot-300 hover:text-idiot-600"
                                  }`}
                                >
                                  Min ${minVal.toFixed(2)}
                                </button>
                              )}
                              {maxVal !== undefined && (
                                <button
                                  type="button"
                                  onClick={() => setNotional(String(maxVal))}
                                  disabled={isFull}
                                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                                    notional === String(maxVal)
                                      ? "border-idiot-300 bg-idiot-50 text-idiot-700"
                                      : "border-slate-200 text-slate-500 hover:border-idiot-300 hover:text-idiot-600"
                                  }`}
                                >
                                  Max ${maxVal.toFixed(2)}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                        <input
                          id="notional"
                          type="number"
                          value={notional}
                          onChange={(e) => setNotional(e.target.value)}
                          placeholder={maxVal ? maxVal.toFixed(2) : "100.00"}
                          min={minVal}
                          step="0.01"
                          max={maxVal}
                          className="input"
                          required
                          disabled={isFull}
                        />
                        <p className="text-xs text-slate-500 mt-1">
                          Your notional amount. This determines the signal fee and the Genius&apos;s collateral commitment.
                        </p>
                      </>
                    );
                  })()}
                </div>


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
                    isProcessing || purchaseLoading || signalAvailable === false
                  }
                  className="btn-primary w-full py-3"
                >
                  {isProcessing
                    ? "Processing..."
                    : signalAvailable === false
                      ? "Unavailable"
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
