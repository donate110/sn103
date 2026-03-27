"use client";

import { useState, useRef, useEffect } from "react";

const GLOSSARY: Record<string, string> = {
  MPC: "Multi-Party Computation: a cryptographic technique where multiple parties jointly compute a result without any party seeing the others' inputs. Djinn validators use MPC to verify signal availability and compute settlement scores without revealing the real pick.",
  "Shamir's Secret Sharing": "A method of splitting a secret into multiple pieces (shares), where you need a minimum number of shares (the threshold) to reconstruct it. A single share reveals nothing about the secret.",
  "Shamir secret sharing": "A method of splitting a secret into multiple pieces (shares), where you need a minimum number of shares (the threshold) to reconstruct it. A single share reveals nothing about the secret.",
  USDC: "USD Coin: a stablecoin pegged 1:1 to the US dollar, issued by Circle. Djinn uses USDC on the Base blockchain for all deposits, fees, and settlements.",
  "Quality Score": "An aggregate measure of a Genius's prediction accuracy over a 10-signal cycle, computed by MPC across validators. Positive scores mean the Genius performed well; negative scores trigger collateral slashing.",
  "AES-256-GCM": "Advanced Encryption Standard with 256-bit keys in Galois/Counter Mode. A widely-used, high-security symmetric encryption algorithm. Djinn uses it to encrypt signal content client-side.",
  Bittensor: "A decentralized AI network where validators incentivize miners to perform useful work. Djinn runs on Subnet 103, using validators for MPC settlement and miners for sports data attestation via TLSNotary.",
  TLSNotary: "A protocol that lets you prove you received specific data from a website without revealing your session details. Miners use TLSNotary to cryptographically attest that a betting line is available at a sportsbook.",
  Base: "An Ethereum Layer 2 blockchain built by Coinbase. Djinn deploys its smart contracts on Base for low-cost, fast transactions settled in USDC.",
  "UUPS proxy": "Universal Upgradeable Proxy Standard: a smart contract pattern where users interact with a permanent proxy address, while the underlying logic can be upgraded through a governance process (in Djinn's case, a 72-hour timelock).",
  "decoy lines": "Nine fake betting lines bundled with the real pick inside a signal. They make it impossible for anyone (including validators) to determine which line is the actual prediction without reconstructing the Shamir secret.",
  SLA: "Service-Level Agreement: the terms a Genius commits to when creating a signal. The SLA multiplier determines how much collateral is slashed if predictions underperform.",
};

interface TooltipProps {
  term: string;
  children?: React.ReactNode;
}

export default function Tooltip({ term, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const definition = GLOSSARY[term];

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!definition) {
    return <>{children || term}</>;
  }

  return (
    <span ref={ref} className="relative inline">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="border-b border-dotted border-slate-400 text-inherit font-inherit cursor-help"
      >
        {children || term}
      </button>
      {open && (
        <span className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 rounded-lg bg-slate-900 text-white text-xs leading-relaxed px-3 py-2.5 shadow-lg pointer-events-none">
          <span className="font-semibold">{term}:</span>{" "}
          {definition}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
        </span>
      )}
    </span>
  );
}

/**
 * Utility: wrap known glossary terms in a text string with tooltips.
 * For use in JSX when you want automatic term detection.
 */
export function glossaryTerms(): string[] {
  return Object.keys(GLOSSARY);
}
