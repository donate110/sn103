"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useWalletClient } from "wagmi";
import { useCommitSignal, useCollateral, useDepositCollateral, useWalletUsdcBalance } from "@/lib/hooks";
import { getSavedSignals, saveSavedSignals } from "@/lib/hooks/useSettledSignals";
import { ADDRESSES } from "@/lib/contracts";
import SecretModal from "@/components/SecretModal";
import PrivateWorkspace from "@/components/PrivateWorkspace";
import {
  generateAesKey,
  encrypt,
  splitSecret,
  keyToBigInt,
  toHex,
  deriveMasterSeedTyped,
  deriveSignalKey,
  isMasterSeedCached,
} from "@/lib/crypto";
import { discoverValidatorClients, getMinerClient } from "@/lib/api";
import { useActiveSignals } from "@/lib/hooks/useSignals";
import { fetchProtocolStats } from "@/lib/subgraph";
import { formatUsdc } from "@/lib/types";
import {
  SPORT_GROUPS,
  SPORTS,
  generateDecoys,
  extractBets,
  betToLine,
  formatLine,
  formatOdds,
  usesDecimalOdds,
  serializeLine,
  toCandidateLine,
  type OddsEvent,
  type AvailableBet,
  type StructuredLine,
  type SportOption,
} from "@/lib/odds";

const SHAMIR_TOTAL_SHARES = parseInt(process.env.NEXT_PUBLIC_SHAMIR_TOTAL ?? "10", 10);
const SHAMIR_THRESHOLD = parseInt(process.env.NEXT_PUBLIC_SHAMIR_THRESHOLD ?? "7", 10);

type WizardStep = "browse" | "review" | "configure" | "preflight" | "committing" | "distributing" | "success" | "error";

export default function CreateSignal() {
  const router = useRouter();
  const { isConnected, address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { commit, loading: commitLoading, error: commitError } =
    useCommitSignal();
  const { signals: existingSignals } = useActiveSignals(undefined, address);
  const signalCount = existingSignals.length;
  const MAX_PROOF_SIGNALS = 20;

  // Collateral for inline deposit on configure step
  const { deposit: collateralDeposit, available: collateralAvailable, refresh: refreshCollateral } = useCollateral(address);
  const { deposit: depositCollateral, loading: depositCollateralLoading } = useDepositCollateral();
  const { balance: walletUsdc } = useWalletUsdcBalance(address);
  const [inlineDepositAmount, setInlineDepositAmount] = useState("");
  const [inlineDepositError, setInlineDepositError] = useState<string | null>(null);

  // Wizard step
  const [step, setStep] = useState<WizardStep>("browse");

  // Step 1: Browse
  const [selectedSport, setSelectedSport] = useState<SportOption>(SPORTS[0]);
  const [events, setEvents] = useState<OddsEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedBet, setSelectedBet] = useState<AvailableBet | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Step 2: Review lines
  const [realPick, setRealPick] = useState<StructuredLine | null>(null);
  const [decoyLines, setDecoyLines] = useState<StructuredLine[]>([]);
  const [realIndex, setRealIndex] = useState(0);

  // Odds: market reference and genius's signal odds (American format string)
  const [marketOdds, setMarketOdds] = useState<number | null>(null);
  const [editOdds, setEditOdds] = useState("");
  // Which line is expanded for editing (0-9 index, null = none)
  const [expandedLine, setExpandedLine] = useState<number | null>(null);
  const [decoysExpanded, setDecoysExpanded] = useState(false);

  // Per-book prices derived from current realPick side/line (updates when side changes)
  const bookPrices = useMemo(() => {
    if (!selectedBet || !realPick) return [];
    const prices: { book: string; price: number }[] = [];
    for (const bk of selectedBet.event.bookmakers) {
      for (const mkt of bk.markets) {
        if (mkt.key !== realPick.market) continue;
        for (const outcome of mkt.outcomes) {
          if (outcome.name === realPick.side && (outcome.point ?? null) === (realPick.line ?? null)) {
            prices.push({ book: bk.title, price: outcome.price });
          }
        }
      }
    }
    return prices.sort((a, b) => b.price - a.price);
  }, [selectedBet, realPick]);

  // Step 3: Configure
  const [maxPriceBps, setMaxPriceBps] = useState("10");
  const [slaMultiplier, setSlaMultiplier] = useState("100");
  const [maxNotional, setMaxNotional] = useState("100");
  const [minNotional, setMinNotional] = useState("");
  const [isExclusive, setIsExclusive] = useState(false);
  const [expiresIn, setExpiresIn] = useState("24");
  const [selectedSportsbooks, setSelectedSportsbooks] = useState<string[]>([]);

  // Master seed derivation — prompt on page load so it's cached before submit
  const [seedDeriving, setSeedDeriving] = useState(false);
  const seedAttemptedRef = useRef(false);

  useEffect(() => {
    if (!walletClient || seedAttemptedRef.current || isMasterSeedCached()) return;
    seedAttemptedRef.current = true;
    setSeedDeriving(true);
    deriveMasterSeedTyped(async (params) => {
      const sig = await walletClient.signTypedData(params);
      return sig;
    })
      .catch(() => {
        // User dismissed — the submit flow will retry if needed
      })
      .finally(() => setSeedDeriving(false));
  }, [walletClient]);

  // Platform liquidity (from subgraph)
  const [totalVolume, setTotalVolume] = useState<string | null>(null);

  // Progress
  const [txHash, setTxHash] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  // Sort events by commence time, exclude live/started games, and filter by search
  const filteredEvents = useMemo(() => {
    const now = Date.now();
    const sorted = [...events]
      .filter((ev) => new Date(ev.commence_time).getTime() > now) // Only upcoming games
      .sort(
        (a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime(),
      );
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter(
      (ev) =>
        ev.home_team.toLowerCase().includes(q) ||
        ev.away_team.toLowerCase().includes(q),
    );
  }, [events, searchQuery]);

  const fetchEvents = useCallback(async (sport: SportOption) => {
    setEventsLoading(true);
    setEventsError(null);
    setEvents([]);
    setSelectedBet(null);
    setSearchQuery("");
    try {
      const resp = await fetch(`/api/odds?sport=${sport.key}`);
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(data.error || `Failed to load games (${resp.status})`);
      }
      const data: OddsEvent[] = await resp.json();
      setEvents(data);
    } catch (err) {
      setEventsError(
        err instanceof Error ? err.message : "Failed to load games",
      );
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isConnected) {
      fetchEvents(selectedSport);
    }
  }, [selectedSport, isConnected, fetchEvents]);

  // Fetch platform-wide liquidity once
  useEffect(() => {
    fetchProtocolStats().then((stats) => {
      if (stats?.totalVolume) setTotalVolume(stats.totalVolume);
    }).catch(() => {});
  }, []);


  const handleSelectBet = (bet: AvailableBet) => {
    setSelectedBet(bet);
    const pick = betToLine(bet);
    setRealPick(pick);
    setMarketOdds(bet.avgPrice);
    setEditOdds(decimalToAmerican(bet.avgPrice));
    setSelectedSportsbooks(bet.books);
    const decoys = generateDecoys(pick, events, 9);
    setDecoyLines(decoys);
    const pos = cryptoRandomInt(10);
    setRealIndex(pos);
    setExpandedLine(pos);
    setStep("review");
  };

  const handleRegenerateDecoys = () => {
    if (!realPick) return;
    const decoys = generateDecoys(realPick, events, 9);
    setDecoyLines(decoys);
    setRealIndex(cryptoRandomInt(10));
  };

  const getAllLines = (): StructuredLine[] => {
    if (!realPick) return [];
    const lines: StructuredLine[] = [];
    let decoyIdx = 0;
    for (let i = 0; i < 10; i++) {
      if (i === realIndex) {
        lines.push(realPick);
      } else {
        lines.push(decoyLines[decoyIdx++]);
      }
    }
    return lines;
  };

  /** Update any line (real pick or decoy) by its global 0-9 index. */
  const updateLine = (globalIdx: number, updates: Partial<StructuredLine>) => {
    if (globalIdx === realIndex) {
      setRealPick((prev) => prev ? { ...prev, ...updates } : prev);
      // Sync editOdds if price changed on the real pick
      if (updates.price != null) {
        setEditOdds(decimalToAmerican(updates.price));
      }
    } else {
      const decoyIdx = globalIdx < realIndex ? globalIdx : globalIdx - 1;
      setDecoyLines((prev) =>
        prev.map((d, i) => (i === decoyIdx ? { ...d, ...updates } : d)),
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStepError(null);

    if (!realPick) {
      setStepError("No signal selected");
      return;
    }

    const geniusAddress = address;
    if (!geniusAddress) {
      setStepError("Wallet address not available");
      return;
    }

    // Sync realPick.price from editOdds to prevent stale odds in serialized lines
    const minOddsDecimal = editOdds ? americanToDecimal(editOdds) : null;
    if (minOddsDecimal != null && realPick.price !== minOddsDecimal) {
      setRealPick((prev) => prev ? { ...prev, price: minOddsDecimal } : prev);
      // Also update the local reference for this submission
      realPick.price = minOddsDecimal;
    }

    const allLines = getAllLines();
    if (allLines.length !== 10) {
      setStepError("Expected 10 lines");
      return;
    }

    try {
      // Show immediate feedback
      setStep("preflight");

      // Pre-flight: discover validators and check that enough are reachable
      const preflightValidators = await discoverValidatorClients();
      if (preflightValidators.length < SHAMIR_THRESHOLD) {
        setStepError(
          `Only ${preflightValidators.length} validators discovered, need ${SHAMIR_THRESHOLD}. Try again in a moment.`,
        );
        setStep("configure");
        return;
      }
      const healthChecks = await Promise.allSettled(
        preflightValidators.map((v) => v.health()),
      );
      const healthyCount = healthChecks.filter(
        (r) => r.status === "fulfilled" && r.value.status === "ok",
      ).length;
      if (healthyCount < SHAMIR_THRESHOLD) {
        setStepError(
          `Only ${healthyCount} of ${SHAMIR_THRESHOLD} required validators are reachable. Try again in a moment.`,
        );
        setStep("configure");
        return;
      }

      // Pre-flight: miner executability check — ALL 10 lines must be available.
      // Miners are blind to which line is real. If any line fails, the signal cannot be created.
      // This prevents Geniuses from creating signals with fake/expired lines to game results.
      let minerVerified = false;
      const candidateLines = allLines.map((line, i) => toCandidateLine(line, i + 1));
      try {
        const minerClient = getMinerClient();
        const checkResult = await minerClient.checkLines({ lines: candidateLines });

        // If the miner's upstream data source returned an error (e.g. 401, 500),
        // surface it distinctly so the user knows it's a data-source problem, not
        // that their pick is unavailable.
        if (checkResult.api_error) {
          setStepError(
            "The miner's odds data source is experiencing errors and cannot verify your lines right now.\n" +
            `(${checkResult.api_error})\n` +
            "Please try again in a few minutes.",
          );
          setStep("configure");
          return;
        }

        // Check which lines failed
        const failedLines: number[] = [];
        const realLineIdx = realIndex + 1; // Protocol uses 1-indexed
        let realLineFailed = false;

        for (let i = 1; i <= 10; i++) {
          const result = checkResult.results.find((r) => r.index === i);
          if (!result || !result.available) {
            failedLines.push(i);
            if (i === realLineIdx) realLineFailed = true;
          }
        }

        if (realLineFailed) {
          // Real pick is unavailable — hard block, must pick a new bet
          setStepError(
            "Your pick is not currently available at any sportsbook. " +
            "The line may have moved or the game may have started. Please select a different bet.",
          );
          setStep("browse");
          return;
        }

        if (failedLines.length > 0) {
          // Decoys are unavailable — send back to review so Genius can fix
          const failedStr = failedLines.map((n) => `#${n}`).join(", ");
          setStepError(
            `${failedLines.length} decoy line${failedLines.length > 1 ? "s" : ""} (${failedStr}) ` +
            `${failedLines.length > 1 ? "are" : "is"} not currently executable. ` +
            "All 10 lines must be available at sportsbooks. " +
            "Try regenerating decoys or editing the failed lines, then re-submit.",
          );
          setStep("review");
          return;
        }

        minerVerified = true;
      } catch (minerErr) {
        console.warn("Miner executability check failed, signal will be marked unverified:", minerErr);
      }

      setStep("committing");

      // Generate signalId first so we can derive the AES key from it
      const signalId = BigInt(
        "0x" +
          Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
      );

      // Derive AES key from wallet via EIP-712 signTypedData.
      // Unlike personal_sign, EIP-712 works on ERC-4337 smart wallets
      // (Coinbase Smart Wallet, etc.). Same wallet always produces the
      // same key, enabling cross-device recovery.
      //
      // The master seed is pre-derived on page load (see seedDeriving
      // state above), so this call normally returns instantly from
      // cache — no wallet popup here.
      if (!walletClient) throw new Error("Wallet not connected");
      let aesKey: Uint8Array;
      try {
        const masterSeed = await deriveMasterSeedTyped(
          async (params) => {
            const sig = await walletClient.signTypedData(params);
            return sig;
          },
        );
        aesKey = await deriveSignalKey(masterSeed, signalId);
      } catch (keyErr) {
        console.warn("EIP-712 key derivation failed, using random key (cross-device recovery unavailable):", keyErr);
        aesKey = generateAesKey();
      }

      const pickPayload = JSON.stringify({
        realIndex: realIndex + 1,
        pick: formatLine(realPick),
        minOdds: minOddsDecimal,
        minOddsAmerican: editOdds || null,
      });
      const { ciphertext, iv } = await encrypt(pickPayload, aesKey);
      const encryptedBlob = `${iv}:${ciphertext}`;

      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(encryptedBlob),
      );
      const commitHash =
        "0x" +
        Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

      const expiresInNum = parseFloat(expiresIn);
      const maxPriceNum = parseFloat(maxPriceBps);
      const slaNum = parseFloat(slaMultiplier);
      if (isNaN(expiresInNum) || !Number.isFinite(expiresInNum) || expiresInNum <= 0) {
        setStepError("Invalid expiration time");
        setStep("configure");
        return;
      }
      if (isNaN(maxPriceNum) || !Number.isFinite(maxPriceNum) || maxPriceNum <= 0 || maxPriceNum > 100) {
        setStepError("Invalid max price (must be 0-100%)");
        setStep("configure");
        return;
      }
      if (isNaN(slaNum) || !Number.isFinite(slaNum) || slaNum < 100 || slaNum > 1000) {
        setStepError("Invalid SLA multiplier (must be 100-1000%)");
        setStep("configure");
        return;
      }
      const maxNotionalNum = parseFloat(maxNotional);
      if (isNaN(maxNotionalNum) || !Number.isFinite(maxNotionalNum) || maxNotionalNum < 1) {
        setStepError("Invalid max notional (must be at least $1)");
        setStep("configure");
        return;
      }

      const expiresAt = BigInt(
        Math.floor(Date.now() / 1000) + expiresInNum * 3600,
      );

      const serializedLines = allLines.map(serializeLine);

      const hash = await commit({
        signalId,
        encryptedBlob: "0x" + toHex(encoder.encode(encryptedBlob)),
        commitHash,
        sport: selectedSport.label,
        maxPriceBps: BigInt(Math.round(maxPriceNum * 100)),
        slaMultiplierBps: BigInt(Math.round(slaNum * 100)),
        maxNotional: BigInt(Math.round(maxNotionalNum * 1e6)),
        minNotional: minNotional ? BigInt(Math.round(parseFloat(minNotional) * 1e6)) : 0n,
        expiresAt,
        decoyLines: serializedLines,
        availableSportsbooks: selectedSportsbooks,
      });
      setTxHash(hash);

      setStep("distributing");

      const keyBigInt = keyToBigInt(aesKey);
      const shares = splitSecret(keyBigInt, SHAMIR_TOTAL_SHARES, SHAMIR_THRESHOLD);

      // Also Shamir-split the real index for MPC executability checks
      // realIndex is 0-based internally, but 1-indexed for the protocol (1-10)
      const indexBigInt = BigInt(realIndex + 1);
      const indexShares = splitSecret(indexBigInt, SHAMIR_TOTAL_SHARES, SHAMIR_THRESHOLD);

      const validators = preflightValidators;
      const signalIdStr = signalId.toString();

      const storePromises = shares.map((share, i) => {
        const validator = validators[i % validators.length];
        // Send only the individual Shamir share — NEVER the full AES key
        const shareHex = share.y.toString(16).padStart(64, "0");
        const indexShareHex = indexShares[i].y.toString(16).padStart(64, "0");
        return validator.storeShare({
          signal_id: signalIdStr,
          genius_address: geniusAddress,
          share_x: share.x,
          share_y: share.y.toString(16),
          encrypted_key_share: shareHex,
          encrypted_index_share: indexShareHex,
        });
      });

      const results = await Promise.allSettled(storePromises);
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      if (succeeded < SHAMIR_THRESHOLD) {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => r.reason?.message || String(r.reason))
          .slice(0, 3);
        throw new Error(
          `Key distribution failed: ${succeeded} of ${SHAMIR_THRESHOLD} required validators responded.\n${errors.join("\n")}`,
        );
      }
      if (failed > 0) {
        console.warn(`${failed}/10 share stores failed (${succeeded} succeeded)`);
      }

      // Persist private signal data for wallet recovery and audit tracking
      const newEntry = {
        signalId: signalId.toString(),
        preimage: keyToBigInt(aesKey).toString(),
        realIndex: realIndex + 1, // 1-indexed
        sport: selectedSport.label,
        pick: formatLine(realPick),
        minOdds: minOddsDecimal,
        minOddsAmerican: editOdds || null,
        slaMultiplierBps: Math.round(slaNum * 100),
        createdAt: Math.floor(Date.now() / 1000),
        minerVerified,
      };
      const existing = getSavedSignals(geniusAddress);
      const updated = [...existing, newEntry];
      saveSavedSignals(geniusAddress, updated);

      setStep("success");
      setTimeout(() => router.push("/genius"), 3000);
    } catch (err) {
      const { humanizeError } = await import("@/lib/hooks");
      const msg = humanizeError(err, "Signal creation failed");
      setStepError(msg);
      // Stay on configure page for recoverable errors (wallet, validation)
      // so the user can fix and retry without losing their settings
      setStep("configure");
    }
  };

  if (!isConnected) {
    return (
      <div className="text-center py-20">
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Create Signal
        </h1>
        <p className="text-slate-500">
          Connect your wallet to create a signal.
        </p>
      </div>
    );
  }

  // ---------- Success ----------
  if (step === "success") {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Signal Committed & Shares Distributed
        </h1>
        <p className="text-slate-500 mb-2">
          Your signal has been committed on-chain and encryption key shares
          have been distributed to validators.
        </p>
        <p className="text-sm text-slate-500 font-mono break-all mb-8">
          tx: {txHash}
        </p>
        <button onClick={() => router.push("/genius")} className="btn-primary">
          Back to Dashboard
        </button>
      </div>
    );
  }

  // ---------- Error ----------
  if (step === "error") {
    return (
      <div className="max-w-2xl mx-auto text-center py-20">
        <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-900 mb-4">
          Signal Creation Failed
        </h1>
        <p className="text-sm text-red-600 mb-8 whitespace-pre-line">{stepError}</p>
        <button onClick={() => setStep("browse")} className="btn-primary">
          Try Again
        </button>
      </div>
    );
  }

  const isProcessing = step === "preflight" || step === "committing" || step === "distributing";
  const isInteractiveStep = step === "browse" || step === "review" || step === "configure";

  // ---------- Step 1: Browse games & pick a bet ----------
  if (step === "browse") {
    return (
      <PrivateWorkspace open onClose={() => router.push("/genius")}>
      <div className="max-w-3xl mx-auto">
        {/* Encryption key derivation overlay — shown once on first visit */}
        {seedDeriving && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
            <div className="text-center max-w-sm mx-auto px-6">
              <div className="inline-block w-10 h-10 border-2 border-genius-500 border-t-transparent rounded-full animate-spin mb-4" />
              <h2 className="text-lg font-semibold text-slate-900 mb-2">Setting up encryption</h2>
              <p className="text-sm text-slate-500">
                Your wallet will ask you to sign a message. This is free (no gas)
                and derives your encryption key so your picks stay secret.
              </p>
            </div>
          </div>
        )}
        <WizardStepper currentStep="browse" />
        {stepError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 mb-4" role="alert">
            <p className="text-sm text-red-600 whitespace-pre-line">{stepError}</p>
          </div>
        )}
        <div className="flex items-start justify-between gap-4 mb-2">
          <h1 className="text-3xl font-bold text-slate-900">Create Signal</h1>
          {totalVolume && (
            <div className="text-right flex-shrink-0">
              <p className="text-[10px] text-slate-400 uppercase tracking-wide">Platform Liquidity</p>
              <p className="text-sm font-semibold text-genius-700">
                ${formatUsdc(BigInt(totalVolume))}
              </p>
            </div>
          )}
        </div>
        <p className="text-slate-500 mb-6">
          Browse upcoming games and select your signal. The system will auto-generate
          plausible decoy lines from real odds data.
        </p>

        {signalCount >= MAX_PROOF_SIGNALS && (
          <div className="rounded-lg px-4 py-3 mb-6 text-sm bg-amber-50 text-amber-700 border border-amber-200">
            You have {signalCount} active signals. Audit sets settle every 10 signals
            per buyer. Your track record updates automatically as sets are finalized.
          </div>
        )}

        {/* Sport Selector — horizontal scroll on mobile, grouped grid on desktop */}
        <div className="mb-6">
          {/* Mobile: single horizontal scroll strip */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-5 px-5 sm:hidden scrollbar-hide">
            {SPORTS.map((sport) => (
              <button
                key={sport.key}
                type="button"
                onClick={() => setSelectedSport(sport)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap flex-shrink-0 transition-colors ${
                  selectedSport.key === sport.key
                    ? "bg-genius-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {sport.label}
              </button>
            ))}
          </div>

          {/* Desktop: grouped layout */}
          <div className="hidden sm:block space-y-3">
            {SPORT_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
                  {group.label}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {group.sports.map((sport) => (
                    <button
                      key={sport.key}
                      type="button"
                      onClick={() => setSelectedSport(sport)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                        selectedSport.key === sport.key
                          ? "bg-genius-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {sport.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Search */}
        {events.length > 0 && (
          <div className="mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${selectedSport.label} teams...`}
              className="input w-full"
              autoComplete="off"
              aria-label={`Search ${selectedSport.label} teams`}
            />
          </div>
        )}

        {/* Loading */}
        {eventsLoading && (
          <div className="text-center py-12">
            <div className="inline-block w-8 h-8 border-2 border-genius-500 border-t-transparent rounded-full animate-spin mb-4" />
            <p className="text-sm text-slate-500">Loading {selectedSport.label} games...</p>
          </div>
        )}

        {/* Error */}
        {eventsError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 mb-6" role="alert">
            <p className="text-sm text-red-600">{eventsError}</p>
            <button
              onClick={() => fetchEvents(selectedSport)}
              className="text-sm text-red-700 underline mt-2"
            >
              Retry
            </button>
          </div>
        )}

        {/* No events */}
        {!eventsLoading && !eventsError && events.length === 0 && (
          <div className="text-center py-12">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-slate-500 mb-1">
              No upcoming {selectedSport.label} games found
            </p>
            <p className="text-xs text-slate-400">
              All current games have already started. Try another sport or check back later.
            </p>
          </div>
        )}

        {/* Search no results */}
        {!eventsLoading && events.length > 0 && filteredEvents.length === 0 && (
          <div className="text-center py-12">
            <p className="text-slate-500">
              No games matching &ldquo;{searchQuery}&rdquo;
            </p>
          </div>
        )}

        {/* Events list */}
        {!eventsLoading && filteredEvents.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              {filteredEvents.length} game{filteredEvents.length !== 1 ? "s" : ""} — sorted by start time
            </p>
            {filteredEvents.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                onSelectBet={handleSelectBet}
                oddsFormat={usesDecimalOdds(selectedSport.key) ? "decimal" : "american"}
              />
            ))}
          </div>
        )}
      </div>
      </PrivateWorkspace>
    );
  }

  // ---------- Step 2: Review lines ----------
  if (step === "review") {
    const allLines = getAllLines();
    const sameMarketCount = allLines.filter(
      (l) => l.market === realPick?.market,
    ).length;
    const useDecimal = usesDecimalOdds(selectedSport.key);
    const oddsFormat: "american" | "decimal" = useDecimal ? "decimal" : "american";
    const signalDecimal = editOdds ? americanToDecimal(editOdds) : null;
    const LINE_STEP = 0.5; // spread/total increment for nudge buttons

    return (
      <PrivateWorkspace open onClose={() => router.push("/genius")}>
      <div className="max-w-2xl mx-auto">
        <WizardStepper currentStep="review" />
        <button
          onClick={() => setStep("browse")}
          className="text-sm text-slate-500 hover:text-slate-900 mb-6 transition-colors"
        >
          &larr; Back to Games
        </button>

        {stepError && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 mb-4" role="alert">
            <p className="text-sm text-red-600 whitespace-pre-line">{stepError}</p>
          </div>
        )}
        <h1 className="text-3xl font-bold text-slate-900 mb-2">Review Lines</h1>
        <p className="text-slate-500 mb-4">
          Tap any line to edit it. 9 decoy lines are auto-generated from real odds data.
          Purchasers won&apos;t know which line is yours.
        </p>

        <p className="text-xs text-slate-400 mb-3">
          {sameMarketCount}/10 lines are {realPick?.market === "h2h" ? "moneyline" : realPick?.market} — higher same-market ratio = harder to identify your signal
        </p>

        <div className="space-y-2 mb-6">
          {allLines.map((line, i) => {
            const isReal = i === realIndex;
            const isDecoy = !isReal;
            // Skip decoys when collapsed
            if (isDecoy && !decoysExpanded) return null;
            const isExpanded = expandedLine === i;
            const sides = line.market === "totals"
              ? ["Over", "Under"]
              : [line.home_team, line.away_team];

            return (
              <div
                key={i}
                className={`rounded-lg overflow-hidden transition-all ${
                  isReal
                    ? "border-2 border-genius-300 bg-genius-50"
                    : "border border-slate-200 bg-slate-50"
                }`}
              >
                {/* Collapsed row — click to expand */}
                <div
                  className={`flex items-center gap-3 px-4 py-3 text-sm cursor-pointer ${
                    isReal ? "font-medium text-genius-800" : "text-slate-600"
                  }`}
                  onClick={() => setExpandedLine(isExpanded ? null : i)}
                >
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                    isReal ? "bg-genius-500 text-white" : "bg-slate-200 text-slate-500"
                  }`}>
                    {i + 1}
                  </span>
                  <span className="flex-1 min-w-0 truncate">{formatLine(line, oddsFormat)}</span>
                  {isReal && (
                    <span className="text-xs bg-genius-200 text-genius-700 rounded px-2 py-0.5 flex-shrink-0">
                      YOUR PICK
                    </span>
                  )}
                  <svg
                    className={`w-4 h-4 flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""} ${isReal ? "text-genius-500" : "text-slate-400"}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {/* Expanded edit panel */}
                {isExpanded && (
                  <div className={`px-4 pb-4 pt-2 border-t space-y-3 ${isReal ? "border-genius-200" : "border-slate-200"}`}>
                    {/* Side selector */}
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Side</p>
                      <div className="flex gap-2">
                        {sides.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => updateLine(i, { side: s })}
                            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                              line.side === s
                                ? isReal ? "bg-genius-500 text-white" : "bg-slate-700 text-white"
                                : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Change game — decoys only */}
                    {!isReal && (
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">Game</p>
                        <select
                          value={line.event_id}
                          onChange={(e) => {
                            const ev = events.find((ev) => ev.id === e.target.value);
                            if (!ev) return;
                            updateLine(i, {
                              event_id: ev.id,
                              home_team: ev.home_team,
                              away_team: ev.away_team,
                              sport: ev.sport_key,
                            });
                          }}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:ring-2 focus:ring-genius-400"
                        >
                          {events.map((ev) => (
                            <option key={ev.id} value={ev.id}>
                              {ev.away_team} @ {ev.home_team}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Line value (spreads/totals only) */}
                    {line.market !== "h2h" && (
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">
                          {line.market === "spreads" ? "Spread" : "Total"}
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            step="0.5"
                            value={line.line ?? ""}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              if (!isNaN(val) && Number.isFinite(val)) {
                                updateLine(i, { line: val });
                              }
                            }}
                            className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-genius-400"
                          />
                          <button
                            type="button"
                            onClick={() => updateLine(i, { line: (line.line ?? 0) - LINE_STEP })}
                            className="w-8 h-8 rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 font-bold text-sm flex-shrink-0 flex items-center justify-center"
                          >
                            &minus;
                          </button>
                          <input
                            type="range"
                            min={line.market === "totals" ? 100 : -15}
                            max={line.market === "totals" ? 300 : 15}
                            step="0.5"
                            value={line.line ?? 0}
                            onChange={(e) => updateLine(i, { line: parseFloat(e.target.value) })}
                            className="flex-1 accent-genius-500 h-2"
                          />
                          <button
                            type="button"
                            onClick={() => updateLine(i, { line: (line.line ?? 0) + LINE_STEP })}
                            className="w-8 h-8 rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 font-bold text-sm flex-shrink-0 flex items-center justify-center"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Odds */}
                    <div>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">
                        {isReal ? "Signal Odds" : "Odds"}{useDecimal ? " (decimal)" : " (American)"}
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={
                            useDecimal
                              ? (isReal ? (signalDecimal?.toFixed(2) ?? line.price?.toFixed(2) ?? "") : (line.price?.toFixed(2) ?? ""))
                              : (isReal ? editOdds : (line.price ? decimalToAmerican(line.price) : ""))
                          }
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (useDecimal) {
                              if (!/^\d*\.?\d{0,2}$/.test(raw)) return;
                              const dec = parseFloat(raw);
                              if (!isNaN(dec) && dec >= 1.01) {
                                if (isReal) {
                                  setEditOdds(decimalToAmerican(dec));
                                  setRealPick((prev) => prev ? { ...prev, price: dec } : prev);
                                } else {
                                  updateLine(i, { price: dec });
                                }
                              }
                            } else {
                              if (!/^[+-]?\d*$/.test(raw)) return;
                              if (isReal) {
                                setEditOdds(raw);
                                const dec = americanToDecimal(raw);
                                if (dec != null) setRealPick((prev) => prev ? { ...prev, price: dec } : prev);
                              } else {
                                const dec = americanToDecimal(raw);
                                if (dec != null) updateLine(i, { price: dec });
                              }
                            }
                          }}
                          placeholder={useDecimal ? "1.91" : "-110"}
                          className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-mono focus:ring-2 focus:ring-genius-400"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const cur = isReal ? (signalDecimal ?? line.price ?? 1.91) : (line.price ?? 1.91);
                            const next = nudgeOdds(cur, -1, useDecimal);
                            if (isReal) {
                              setEditOdds(decimalToAmerican(next));
                              setRealPick((prev) => prev ? { ...prev, price: next } : prev);
                            } else {
                              updateLine(i, { price: next });
                            }
                          }}
                          className="w-8 h-8 rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 font-bold text-sm flex-shrink-0 flex items-center justify-center"
                        >
                          &minus;
                        </button>
                        <input
                          type="range"
                          min="1.1"
                          max="10"
                          step="0.01"
                          value={isReal ? (signalDecimal ?? line.price ?? 1.91) : (line.price ?? 1.91)}
                          onChange={(e) => {
                            const dec = parseFloat(e.target.value);
                            if (isReal) {
                              setEditOdds(decimalToAmerican(dec));
                              setRealPick((prev) => prev ? { ...prev, price: dec } : prev);
                            } else {
                              updateLine(i, { price: dec });
                            }
                          }}
                          className="flex-1 accent-genius-500 h-2"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const cur = isReal ? (signalDecimal ?? line.price ?? 1.91) : (line.price ?? 1.91);
                            const next = nudgeOdds(cur, 1, useDecimal);
                            if (isReal) {
                              setEditOdds(decimalToAmerican(next));
                              setRealPick((prev) => prev ? { ...prev, price: next } : prev);
                            } else {
                              updateLine(i, { price: next });
                            }
                          }}
                          className="w-8 h-8 rounded-lg bg-slate-200 text-slate-600 hover:bg-slate-300 font-bold text-sm flex-shrink-0 flex items-center justify-center"
                        >
                          +
                        </button>
                      </div>
                      {isReal && (
                        <p className="text-[10px] text-genius-500 mt-1">
                          The odds at which you value this signal.
                        </p>
                      )}
                    </div>

                    {/* Market depth — real pick only */}
                    {isReal && bookPrices.length > 0 && (() => {
                      const bestPrice = bookPrices[0].price;
                      const worstPrice = bookPrices[bookPrices.length - 1].price;
                      const hasRange = bestPrice !== worstPrice;
                      return (
                      <div className="rounded-lg bg-white border border-genius-200 overflow-hidden">
                        <p className="text-[10px] text-genius-600 uppercase tracking-wide font-medium px-3 pt-2 pb-1">
                          Market Depth — tap a book to use its odds
                        </p>
                        <table className="w-full text-xs">
                          <tbody>
                            {bookPrices.map(({ book, price }, bi) => {
                              const displayOdds = formatOdds(price, oddsFormat);
                              const isBest = hasRange && price === bestPrice;
                              const isWorst = hasRange && price === worstPrice;
                              const atOrBetter = signalDecimal != null && price >= signalDecimal - 0.001;
                              return (
                                <tr
                                  key={`${book}-${bi}`}
                                  className={`cursor-pointer transition-colors hover:bg-genius-100 active:bg-genius-200 ${
                                    isBest ? "bg-green-50" : isWorst ? "bg-red-50" : ""
                                  }`}
                                  onClick={() => {
                                    setEditOdds(decimalToAmerican(price));
                                    setRealPick((prev) => prev ? { ...prev, price } : prev);
                                  }}
                                >
                                  <td className="w-5 pl-2.5 py-2.5">
                                    {atOrBetter ? (
                                      <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                      </svg>
                                    ) : (
                                      <span className="w-3.5 h-3.5 block" />
                                    )}
                                  </td>
                                  <td className={`py-2.5 font-medium ${
                                    isBest ? "text-green-700" : isWorst ? "text-red-600" : "text-slate-500"
                                  }`}>
                                    {book}
                                    {isBest && <span className="ml-1.5 text-[9px] font-semibold text-green-600 uppercase">Best</span>}
                                    {isWorst && <span className="ml-1.5 text-[9px] font-semibold text-red-500 uppercase">Worst</span>}
                                  </td>
                                  <td className={`pr-3 py-2.5 text-right font-mono font-semibold ${
                                    isBest ? "text-green-700" : isWorst ? "text-red-600" : atOrBetter ? "text-genius-700" : "text-slate-400"
                                  }`}>{displayOdds}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {signalDecimal != null && (
                          <p className="text-[10px] text-genius-500 px-3 py-1.5 border-t border-genius-100">
                            {bookPrices.filter(p => p.price >= signalDecimal - 0.001).length}/{bookPrices.length} at or above your signal odds
                          </p>
                        )}
                      </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          })}

          {/* Decoy toggle */}
          <button
            type="button"
            onClick={() => setDecoysExpanded(!decoysExpanded)}
            className="w-full flex items-center justify-between rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500 hover:bg-slate-100 transition-colors"
          >
            <span>
              {decoysExpanded ? "Hide" : "Show"} 9 decoy lines
              {!decoysExpanded && <span className="text-slate-400 ml-1">(tap to review)</span>}
            </span>
            <svg
              className={`w-4 h-4 text-slate-400 transition-transform ${decoysExpanded ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Sticky CTA bar */}
        <div className="sticky bottom-0 -mx-5 px-5 py-3 sm:-mx-8 sm:px-8 bg-white/95 backdrop-blur-sm border-t border-slate-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] mt-6 -mb-6">
          <div className="flex gap-3 max-w-2xl mx-auto">
            <button
              onClick={handleRegenerateDecoys}
              className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Regenerate
            </button>
            <button
              onClick={() => {
                // Sync realPick.price from editOdds before transitioning
                const dec = editOdds ? americanToDecimal(editOdds) : null;
                if (dec != null) {
                  setRealPick((prev) => prev ? { ...prev, price: dec } : prev);
                }
                setStep("configure");
              }}
              className="btn-primary flex-1 py-2"
            >
              Continue to Pricing
            </button>
          </div>
        </div>
      </div>
      </PrivateWorkspace>
    );
  }

  // ---------- Step 3: Configure & Submit ----------
  return (
    <PrivateWorkspace open onClose={() => router.push("/genius")}>
    <div className="max-w-2xl mx-auto">
      <WizardStepper currentStep="configure" />
      <button
        onClick={() => setStep("review")}
        className="text-sm text-slate-500 hover:text-slate-900 mb-6 transition-colors"
      >
        &larr; Back to Review
      </button>

      <h1 className="text-3xl font-bold text-slate-900 mb-2">Configure Signal</h1>
      <p className="text-slate-500 mb-6">
        Set your pricing and expiration.
      </p>

      {(commitError || stepError) && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 mb-6" role="alert">
          <p className="text-sm text-red-600 whitespace-pre-line">{commitError || stepError}</p>
        </div>
      )}

      {realPick && (
        <div className="rounded-lg bg-genius-50 border border-genius-200 p-4 mb-6">
          <p className="text-xs text-genius-600 uppercase tracking-wide mb-1">Your Pick</p>
          <p className="text-sm font-bold text-genius-800">{formatLine(realPick)}</p>
          <p className="text-xs text-genius-600 mt-1">
            + 9 decoy lines from {selectedSport.label}
            {selectedSportsbooks.length > 0 && (
              <> &middot; {selectedSportsbooks.length} sportsbook{selectedSportsbooks.length !== 1 ? "s" : ""}</>
            )}
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="maxPriceBps" className="label">Signal Fee (%)</label>
          <input
            id="maxPriceBps"
            type="number"
            value={maxPriceBps}
            onChange={(e) => setMaxPriceBps(e.target.value)}
            placeholder="5"
            min="0.01"
            max="50"
            step="0.01"
            className="input"
            required
          />
          {(() => {
            const pct = parseFloat(maxPriceBps);
            if (maxPriceBps && (isNaN(pct) || pct <= 0)) {
              return <p className="text-xs text-red-500 mt-1">Fee must be greater than 0%</p>;
            }
            if (pct > 50) {
              return <p className="text-xs text-red-500 mt-1">Fee cannot exceed 50%</p>;
            }
            return (
              <p className="text-xs text-slate-500 mt-1">
                Percentage buyers pay per purchase. Higher fee = more revenue but fewer buyers.
              </p>
            );
          })()}
          {(() => {
            const pct = parseFloat(maxPriceBps);
            if (!isNaN(pct) && pct > 0 && pct <= 50) {
              return (
                <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 space-y-0.5">
                  <p>At $100 notional, buyer pays <span className="font-semibold text-genius-700">${(100 * pct / 100).toFixed(2)}</span> fee</p>
                  <p>At $500 notional, buyer pays <span className="font-semibold text-genius-700">${(500 * pct / 100).toFixed(2)}</span> fee</p>
                  <p>At $1,000 notional, buyer pays <span className="font-semibold text-genius-700">${(1000 * pct / 100).toFixed(2)}</span> fee</p>
                </div>
              );
            }
            return null;
          })()}
        </div>

        <div>
          <label htmlFor="slaMultiplier" className="label">SLA Multiplier (%)</label>
          <input
            id="slaMultiplier"
            type="number"
            value={slaMultiplier}
            onChange={(e) => setSlaMultiplier(e.target.value)}
            placeholder="100"
            min="100"
            max="1000"
            step="1"
            className="input"
            required
          />
          {(() => {
            const sla = parseFloat(slaMultiplier);
            if (slaMultiplier && !isNaN(sla) && sla < 100) {
              return <p className="text-xs text-red-500 mt-1">SLA multiplier must be at least 100%</p>;
            }
            if (sla > 1000) {
              return <p className="text-xs text-red-500 mt-1">SLA multiplier cannot exceed 1000%</p>;
            }
            return (
              <p className="text-xs text-slate-500 mt-1">
                If your pick is wrong, you pay the buyer up to this % of their stake
                from your locked collateral. 100% means the buyer gets their full
                stake back. Higher = more collateral commitment per purchase.
              </p>
            );
          })()}
        </div>

        <div>
          <label htmlFor="expiresIn" className="label">Expires In (hours)</label>
          <input
            id="expiresIn"
            type="number"
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value)}
            placeholder="24"
            min="1"
            max="168"
            className="input"
            required
          />
          {(() => {
            const hrs = parseFloat(expiresIn);
            if (expiresIn && !isNaN(hrs) && hrs < 1) {
              return <p className="text-xs text-red-500 mt-1">Expiry must be at least 1 hour</p>;
            }
            if (hrs > 168) {
              return <p className="text-xs text-red-500 mt-1">Expiry cannot exceed 168 hours (7 days)</p>;
            }
            return null;
          })()}
          <p className="text-xs text-slate-500 mt-1">
            Signals also become unavailable once the game starts. Setting expiry
            well before game time avoids revealing which event your signal is on.
          </p>
        </div>

        <div>
          <label htmlFor="maxNotional" className="label">Max Notional (USDC)</label>
          <input
            id="maxNotional"
            type="number"
            value={maxNotional}
            onChange={(e) => {
              const val = e.target.value;
              setMaxNotional(val);
              if (isExclusive) setMinNotional(val);
            }}
            placeholder="10000"
            min="1"
            max="1000000000"
            step="1"
            className="input"
            required
          />
          {(() => {
            const mn = parseFloat(maxNotional);
            if (maxNotional && !isNaN(mn) && mn < 1) {
              return <p className="text-xs text-red-500 mt-1">Max notional must be at least $1</p>;
            }
            return (
              <p className="text-xs text-slate-500 mt-1">
                {isExclusive
                  ? "Exactly one buyer will purchase this full amount."
                  : "Total notional capacity for this signal. Multiple buyers can purchase until this is filled."}
              </p>
            );
          })()}
          {(() => {
            const mn = parseFloat(maxNotional);
            const sla = parseFloat(slaMultiplier);
            if (!isNaN(mn) && mn > 0 && !isNaN(sla) && sla > 0) {
              const maxLock = mn * sla / 100;
              return (
                <p className="text-xs text-slate-500 mt-1">
                  At max notional, <span className="font-semibold text-genius-700">${maxLock.toLocaleString()}</span> of your collateral would be locked.
                </p>
              );
            }
            return null;
          })()}
        </div>

        <div className="flex items-start gap-3">
          <input
            id="exclusive"
            type="checkbox"
            checked={isExclusive}
            onChange={(e) => {
              const checked = e.target.checked;
              setIsExclusive(checked);
              if (checked) {
                setMinNotional(maxNotional);
              } else {
                setMinNotional("");
              }
            }}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-genius-600 focus:ring-genius-500"
          />
          <div>
            <label htmlFor="exclusive" className="text-sm font-medium text-slate-700 cursor-pointer">
              Exclusive signal
            </label>
            <p className="text-xs text-slate-500 mt-0.5">
              Only one buyer can purchase this signal for the full notional amount.
            </p>
          </div>
        </div>

        {!isExclusive && (
        <div>
          <label htmlFor="minNotional" className="label">Min Purchase (USDC) <span className="text-slate-400 font-normal">— optional</span></label>
          <input
            id="minNotional"
            type="number"
            value={minNotional}
            onChange={(e) => {
              const val = e.target.value;
              setMinNotional(val);
              // Auto-detect exclusivity: if min == max and both are valid numbers
              const minN = parseFloat(val);
              const maxN = parseFloat(maxNotional);
              if (val && !isNaN(minN) && !isNaN(maxN) && minN === maxN && maxN > 0) {
                setIsExclusive(true);
              }
            }}
            placeholder="0 (no minimum)"
            min="0"
            max={maxNotional || "1000000000"}
            step="1"
            className="input"
          />
          {(() => {
            const minN = parseFloat(minNotional);
            const maxN = parseFloat(maxNotional);
            if (minNotional && !isNaN(minN) && !isNaN(maxN) && minN > maxN) {
              return <p className="text-xs text-red-500 mt-1">Min purchase cannot exceed max notional</p>;
            }
            return (
              <p className="text-xs text-slate-500 mt-1">
                Minimum notional per purchase. Prevents many tiny buyers.
              </p>
            );
          })()}
        </div>
        )}

        <SecretModal
          open={isProcessing}
          title={step === "preflight" ? "Verifying Signal" : step === "committing" ? "Encrypting & Committing Signal" : "Distributing Key Shares"}
          message={step === "preflight"
            ? "Checking validator availability and verifying your lines are live on sportsbooks..."
            : step === "committing"
            ? "Your pick is being encrypted locally, then the encrypted blob is committed on-chain. Nobody can see your pick."
            : "Splitting your encryption key into shares and distributing them to validators. Your full key never leaves this device."}
        >
          <p className="text-xs text-slate-400">
            {step === "committing" ? "Typically 10\u201330 seconds" : "A few seconds"}
          </p>
          {step === "committing" && (
            <p className="text-xs text-slate-400 mt-2">
              Your wallet will ask you to confirm the on-chain transaction.
            </p>
          )}
        </SecretModal>

        {/* Collateral check — genius needs enough to cover SLA */}
        {(() => {
          const maxNotionalUsdc = parseFloat(maxNotional) || 0;
          const slaPct = parseFloat(slaMultiplier) || 100;
          const requiredCollateral = BigInt(Math.round(maxNotionalUsdc * (slaPct / 100) * 1e6));
          const hasEnough = collateralAvailable >= requiredCollateral;

          if (!hasEnough) {
            const needed = Number(requiredCollateral - collateralAvailable) / 1e6;
            const walletHasUsdc = walletUsdc > 0n;
            // Auto-populate deposit amount with shortfall when field is empty
            const displayAmount = inlineDepositAmount || needed.toString();
            return (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 mb-4">
                <p className="text-sm font-medium text-amber-800 mb-1">
                  Collateral needed: ${needed.toLocaleString("en-US")} USDC more
                </p>
                <p className="text-xs text-amber-600 mb-3">
                  At ${maxNotionalUsdc.toLocaleString()} max notional with {slaPct}% SLA, you need ${(Number(requiredCollateral) / 1e6).toLocaleString()} in available collateral.
                  {walletHasUsdc ? ` You have $${(Number(walletUsdc) / 1e6).toLocaleString()} in your wallet.` : ""}
                </p>
                <div className="flex gap-2">
                  <input
                    type="number"
                    placeholder="Amount (USDC)"
                    className="input flex-1 text-sm"
                    value={displayAmount}
                    onChange={(e) => setInlineDepositAmount(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={depositCollateralLoading || !displayAmount}
                    className="btn-primary text-sm whitespace-nowrap"
                    onClick={async () => {
                      setInlineDepositError(null);
                      try {
                        const { parseUsdc } = await import("@/lib/types");
                        await depositCollateral(parseUsdc(displayAmount));
                        setInlineDepositAmount("");
                        refreshCollateral();
                      } catch (err) {
                        const { humanizeError } = await import("@/lib/hooks");
                        setInlineDepositError(humanizeError(err, "Deposit failed"));
                      }
                    }}
                  >
                    {depositCollateralLoading ? "Depositing..." : "Deposit Collateral"}
                  </button>
                </div>
                {inlineDepositError && (
                  <p className="text-xs text-red-600 mt-2">{inlineDepositError}</p>
                )}
              </div>
            );
          }
          return null;
        })()}

        {/* Sticky CTA bar */}
        <div className="sticky bottom-0 -mx-5 px-5 py-3 sm:-mx-8 sm:px-8 bg-white/95 backdrop-blur-sm border-t border-slate-200 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] mt-6 -mb-6">
          <button
            type="submit"
            disabled={isProcessing || commitLoading || (() => {
              const pct = parseFloat(maxPriceBps);
              const sla = parseFloat(slaMultiplier);
              const hrs = parseFloat(expiresIn);
              const mn = parseFloat(maxNotional);
              return isNaN(pct) || pct <= 0 || pct > 50
                || isNaN(sla) || sla < 100 || sla > 1000
                || isNaN(hrs) || hrs < 1 || hrs > 168
                || isNaN(mn) || mn < 1;
            })()}
            className="btn-primary w-full py-3 text-base"
          >
            {isProcessing ? "Processing..." : "Create Signal"}
          </button>
        </div>
      </form>
    </div>
    </PrivateWorkspace>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Format a relative countdown like "Starts in 3h 12m" or "Started 45m ago" */
function timeUntil(dateStr: string): { text: string; isLive: boolean } {
  const target = new Date(dateStr).getTime();
  const now = Date.now();
  const diffMs = target - now;

  if (diffMs <= 0) {
    const ago = Math.abs(diffMs);
    if (ago < 60_000) return { text: "Just started", isLive: true };
    if (ago < 3_600_000) return { text: `Started ${Math.floor(ago / 60_000)}m ago`, isLive: true };
    return { text: `Started ${Math.floor(ago / 3_600_000)}h ago`, isLive: true };
  }

  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return { text: `in ${days}d ${hours % 24}h`, isLive: false };
  }
  if (hours > 0) {
    return { text: `in ${hours}h ${minutes}m`, isLive: false };
  }
  return { text: `in ${minutes}m`, isLive: false };
}

function EventCard({
  event,
  onSelectBet,
  oddsFormat = "american",
}: {
  event: OddsEvent;
  onSelectBet: (bet: AvailableBet) => void;
  oddsFormat?: "american" | "decimal";
}) {
  const [expanded, setExpanded] = useState(false);
  const bets = extractBets(event);
  const { text: countdown, isLive } = timeUntil(event.commence_time);
  const commence = new Date(event.commence_time);

  const spreadBets = bets.filter((b) => b.market === "spreads");
  const totalBets = bets.filter((b) => b.market === "totals");
  const mlBets = bets.filter((b) => b.market === "h2h");

  // Build compact spread preview showing both sides
  const spreadPreview = spreadBets.length >= 2
    ? spreadBets.slice(0, 2).map((b) => {
        const last = b.side.split(" ").pop();
        const sign = b.line != null && b.line > 0 ? "+" : "";
        return `${last} ${sign}${b.line}`;
      })
    : null;

  // Build compact ML preview
  const mlPreview = mlBets.length >= 2
    ? mlBets.slice(0, 2).map((b) => {
        const last = b.side.split(" ").pop();
        return `${last} ${formatOdds(b.avgPrice, oddsFormat)}`;
      })
    : null;

  return (
    <div className="card">
      <div
        className="flex items-center justify-between cursor-pointer gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Left: Teams + time */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-900 truncate">
            {event.away_team} @ {event.home_team}
          </h3>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-xs font-medium ${isLive ? "text-red-600" : "text-slate-500"}`}>
              {isLive ? "LIVE" : countdown}
            </span>
            <span className="text-xs text-slate-400">
              {commence.toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}{" "}
              {commence.toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </div>
        </div>

        {/* Center: Quick odds preview (collapsed only) */}
        {!expanded && (
          <div className="hidden sm:flex items-center gap-4 text-right flex-shrink-0">
            {spreadPreview && (
              <div>
                <p className="text-[10px] text-slate-400 uppercase">Spread</p>
                <div className="text-xs font-mono text-slate-600 space-y-0.5">
                  {spreadPreview.map((s, i) => (
                    <p key={i}>{s}</p>
                  ))}
                </div>
              </div>
            )}
            {mlPreview && (
              <div>
                <p className="text-[10px] text-slate-400 uppercase">ML</p>
                <div className="text-xs font-mono text-slate-600 space-y-0.5">
                  {mlPreview.map((s, i) => (
                    <p key={i}>{s}</p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <svg
          className={`w-5 h-5 text-slate-400 transition-transform flex-shrink-0 ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
          {spreadBets.length > 0 && (
            <BetSection title="Spread" bets={spreadBets} onSelect={onSelectBet} oddsFormat={oddsFormat} />
          )}
          {totalBets.length > 0 && (
            <BetSection title="Total" bets={totalBets} onSelect={onSelectBet} oddsFormat={oddsFormat} />
          )}
          {mlBets.length > 0 && (
            <BetSection title="Moneyline" bets={mlBets} onSelect={onSelectBet} oddsFormat={oddsFormat} />
          )}
          {bets.length === 0 && (
            <p className="text-xs text-slate-400">No odds available for this game</p>
          )}
        </div>
      )}
    </div>
  );
}

function BetSection({
  title,
  bets,
  onSelect,
  oddsFormat = "american",
}: {
  title: string;
  bets: AvailableBet[];
  onSelect: (bet: AvailableBet) => void;
  oddsFormat?: "american" | "decimal";
}) {
  // Group bets into pairs by line value for compact mobile display
  const pairs: AvailableBet[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < bets.length; i++) {
    if (used.has(i)) continue;
    const pair = [bets[i]];
    used.add(i);
    // Find the matching opposite side with the same line
    for (let j = i + 1; j < bets.length; j++) {
      if (used.has(j)) continue;
      if (bets[j].line === bets[i].line && bets[j].side !== bets[i].side) {
        pair.push(bets[j]);
        used.add(j);
        break;
      }
    }
    pairs.push(pair);
  }

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
        {title}
      </p>
      <div className="space-y-2">
        {pairs.map((pair, pi) => {
          const lineVal = pair[0].line;
          const lineStr = pair[0].market === "h2h"
            ? ""
            : lineVal != null
              ? `${lineVal > 0 ? "+" : ""}${lineVal}`
              : "";

          return (
            <div key={pi} className="flex gap-2">
              {pair.map((bet, bi) => {
                const priceStr = formatOdds(bet.avgPrice, oddsFormat);
                const bookLabel = bet.bookCount === 1
                  ? "1 book"
                  : `${bet.bookCount} books`;
                // Use short label: just side name for h2h, side + line for spreads/totals
                const shortSide = bet.market === "h2h"
                  ? bet.side
                  : `${bet.side} ${lineStr}`;

                return (
                  <button
                    key={`${bet.side}-${bet.line}-${bi}`}
                    type="button"
                    onClick={() => onSelect(bet)}
                    className="flex-1 flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left hover:border-genius-400 hover:bg-genius-50 transition-colors group min-w-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 group-hover:text-genius-800 break-words">
                        {shortSide}
                      </p>
                      <p className="text-[10px] text-slate-400 group-hover:text-genius-500">
                        {bookLabel}
                        {bet.bookCount > 1 && bet.minPrice !== bet.maxPrice && (
                          <> &middot; {formatOdds(bet.minPrice, oddsFormat)} to {formatOdds(bet.maxPrice, oddsFormat)}</>
                        )}
                      </p>
                    </div>
                    <span className="text-sm font-mono font-semibold text-slate-600 group-hover:text-genius-600 ml-2 flex-shrink-0">
                      {priceStr}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Convert decimal odds to American format for display. */
function decimalToAmerican(decimal: number): string {
  if (decimal >= 2.0) {
    return `+${Math.round((decimal - 1) * 100)}`;
  }
  if (decimal > 1.0) {
    return `${Math.round(-100 / (decimal - 1))}`;
  }
  return "EVEN";
}

/** Convert American odds string to decimal. Returns null if invalid. */
function americanToDecimal(american: string): number | null {
  const n = parseInt(american, 10);
  if (isNaN(n) || n === 0) return null;
  // Reject invalid American odds in the range (-100, 0) and (0, 100)
  if (n > 0 && n < 100) return null;
  if (n < 0 && n > -100) return null;
  if (n > 0) return 1 + n / 100;      // +150 → 2.50
  return 1 + 100 / Math.abs(n);        // -150 → 1.667
}

/**
 * Nudge decimal odds by ±1 American unit or ±0.01 decimal.
 * For American: convert to American integer, add delta, convert back.
 * Skips the dead zone (-99..+99) automatically.
 */
function nudgeOdds(currentDecimal: number, delta: number, useDecimal: boolean): number {
  if (useDecimal) {
    return Math.max(1.01, Math.min(50, currentDecimal + delta * 0.01));
  }
  // Work in American space: round to nearest integer, step by 1
  let american = 0;
  if (currentDecimal >= 2.0) {
    american = Math.round((currentDecimal - 1) * 100); // positive
  } else if (currentDecimal > 1.0) {
    american = Math.round(-100 / (currentDecimal - 1)); // negative
  }
  american += delta;
  // Skip dead zone: -99..+99 are invalid American odds
  if (american >= -99 && american <= 0) american = delta > 0 ? 100 : -100;
  if (american > 0 && american < 100) american = delta > 0 ? 100 : -100;
  // Clamp
  american = Math.max(-5000, Math.min(5000, american));
  // Convert back to decimal
  if (american > 0) return 1 + american / 100;
  if (american < 0) return 1 + 100 / Math.abs(american);
  return 2.0; // fallback for zero
}

/** Cryptographically secure random integer in [0, max). Uses rejection sampling. */
function cryptoRandomInt(max: number): number {
  if (max <= 0) throw new Error("max must be positive");
  const limit = Math.floor(0x100000000 / max) * max;
  const arr = new Uint32Array(1);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    crypto.getRandomValues(arr);
    if (arr[0] < limit) return arr[0] % max;
  }
}

function WizardStepper({ currentStep }: { currentStep: "browse" | "review" | "configure" }) {
  const steps = [
    { key: "browse", label: "Browse", num: 1 },
    { key: "review", label: "Review", num: 2 },
    { key: "configure", label: "Configure", num: 3 },
  ] as const;
  const currentIdx = steps.findIndex((s) => s.key === currentStep);

  return (
    <div className="flex items-center gap-1 mb-4">
      {steps.map((s, i) => {
        const isActive = s.key === currentStep;
        const isPast = currentIdx > i;
        return (
          <div key={s.key} className="flex items-center gap-1">
            {i > 0 && (
              <div className={`w-4 h-px ${isPast ? "bg-genius-400" : "bg-slate-200"}`} />
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-genius-500 text-white"
                  : isPast
                    ? "bg-genius-100 text-genius-700"
                    : "bg-slate-100 text-slate-400"
              }`}
            >
              <span>{s.num}</span>
              <span className="hidden sm:inline">{s.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
