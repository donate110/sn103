import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About | Djinn",
  description:
    "Learn how Djinn unbundles information from execution. Encrypted predictions, on-chain verified track records, and USDC settlement on Base.",
  openGraph: {
    title: "About Djinn",
    description:
      "Encrypted predictions, on-chain verified track records, and USDC settlement on Base.",
  },
};

export default function About() {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="text-center mb-16">
        <div className="flex items-center gap-3 justify-center mb-4">
          <Image
            src="/djinn-logo.png"
            alt="Djinn"
            width={44}
            height={44}
            className="w-11 h-11"
          />
          <span className="text-3xl sm:text-4xl font-bold text-slate-900 font-wordmark tracking-wide">
            DJINN
          </span>
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-3">
          How It Works
        </h1>
        <p className="text-lg text-slate-500 max-w-2xl mx-auto">
          The sports intelligence marketplace where analysts sell encrypted
          predictions and buyers purchase access. Built on Bittensor Subnet 103,
          settled in USDC on Base.
        </p>
      </div>

      {/* Trust bar */}
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-slate-500 mb-16 pb-16 border-b border-slate-200">
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-idiot-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          AES-256-GCM Encrypted
        </span>
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-idiot-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          On-Chain Track Records
        </span>
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-idiot-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Settled in USDC on Base
        </span>
        <span className="flex items-center gap-2">
          <svg className="w-4 h-4 text-idiot-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Powered by Bittensor
        </span>
      </div>

      {/* How it works — 3 steps */}
      <section className="mb-16">
        <h2 className="text-2xl font-bold text-slate-900 text-center mb-10">
          Three steps. No middlemen.
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          <div className="card text-center">
            <div className="w-12 h-12 rounded-full bg-genius-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-lg font-bold text-genius-600">1</span>
            </div>
            <h3 className="font-semibold text-slate-900 mb-2">Commit Signal</h3>
            <p className="text-sm text-slate-500">
              Geniuses encrypt their prediction with AES-256-GCM and commit it
              on-chain alongside 10 decoy lines.
            </p>
          </div>
          <div className="card text-center">
            <div className="w-12 h-12 rounded-full bg-idiot-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-lg font-bold text-idiot-600">2</span>
            </div>
            <h3 className="font-semibold text-slate-900 mb-2">Purchase Access</h3>
            <p className="text-sm text-slate-500">
              Idiots deposit USDC and purchase signal access. Miners verify
              line availability. The key is released via Shamir secret sharing.
            </p>
          </div>
          <div className="card text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-lg font-bold text-slate-600">3</span>
            </div>
            <h3 className="font-semibold text-slate-900 mb-2">Audit & Settle</h3>
            <p className="text-sm text-slate-500">
              After 10 signals, a validator audit computes the Quality Score. Positive =
              Genius keeps fees. Negative = collateral slashed, credits issued.
            </p>
          </div>
        </div>
      </section>

      {/* For Geniuses / For Idiots */}
      <section className="mb-16">
        <div className="grid md:grid-cols-2 gap-8">
          <div className="rounded-2xl border-2 border-genius-200 bg-genius-50/50 p-8">
            <h3 className="text-xl font-bold text-slate-900 mb-4">For Geniuses</h3>
            <ul className="space-y-3 text-sm text-slate-600">
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-genius-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Monetize your edge without revealing your strategy
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-genius-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Predictions stay encrypted forever &mdash; no front-running
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-genius-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Build an on-chain track record that proves your accuracy
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-genius-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Earn USDC fees directly &mdash; 0.5% protocol fee only
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border-2 border-idiot-200 bg-idiot-50/50 p-8">
            <h3 className="text-xl font-bold text-slate-900 mb-4">For Idiots</h3>
            <ul className="space-y-3 text-sm text-slate-600">
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-idiot-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Access predictions from verified analysts with proven records
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-idiot-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Genius underperforms? You get a USDC refund plus service credits
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-idiot-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Line availability verified by the miner network before purchase
              </li>
              <li className="flex items-start gap-3">
                <svg className="w-5 h-5 text-idiot-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Quality Scores are validator-audited &mdash; no one can fake their record
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Signal lifecycle */}
      <section className="mb-16">
        <h2 className="text-2xl font-bold text-slate-900 text-center mb-3">
          The Signal Lifecycle
        </h2>
        <p className="text-center text-slate-500 mb-10">
          Every signal follows the same trustless path from prediction to settlement.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { step: "Encrypt", desc: "AES-256-GCM encryption with 10 decoy lines" },
            { step: "Commit", desc: "On-chain commitment with collateral locked" },
            { step: "Verify", desc: "Miners confirm real-time line availability" },
            { step: "Reveal", desc: "Shamir key shares released to buyer" },
            { step: "Attest", desc: "Validators independently verify game outcomes" },
            { step: "Consensus", desc: "2/3+ validator agreement required" },
            { step: "Audit", desc: "Validator consensus on Quality Score" },
            { step: "Settle", desc: "USDC distributed based on performance" },
          ].map(({ step, desc }) => (
            <div key={step} className="card !p-4">
              <h4 className="text-sm font-semibold text-slate-900 mb-1">{step}</h4>
              <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Cryptographic guarantees */}
      <section className="mb-16">
        <h2 className="text-2xl font-bold text-slate-900 text-center mb-3">
          Cryptographic Guarantees
        </h2>
        <p className="text-center text-slate-500 mb-10">
          Don&apos;t trust. Verify.
        </p>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="font-semibold text-slate-900 mb-2">Signals stay secret forever</h3>
            <p className="text-sm text-slate-500">
              Each prediction is encrypted with AES-256-GCM and committed alongside
              10 decoy lines. Even after purchase, only the buyer can decrypt.
            </p>
          </div>
          <div className="card">
            <h3 className="font-semibold text-slate-900 mb-2">Track records can&apos;t be faked</h3>
            <p className="text-sm text-slate-500">
              Quality Scores are computed by validator consensus and settled on-chain.
              Results are publicly verifiable and immutable.
            </p>
          </div>
          <div className="card">
            <h3 className="font-semibold text-slate-900 mb-2">Line availability is attested</h3>
            <p className="text-sm text-slate-500">
              Before key release, Bittensor miners verify that the signal&apos;s line
              is actually available at real sportsbooks.
            </p>
          </div>
          <div className="card">
            <h3 className="font-semibold text-slate-900 mb-2">Outcomes are consensus-driven</h3>
            <p className="text-sm text-slate-500">
              Game results are independently attested by multiple validators. 2/3+
              must agree before an outcome is written on-chain.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center pb-8">
        <h2 className="text-2xl font-bold text-slate-900 mb-3">
          Ready to get started?
        </h2>
        <p className="text-slate-500 mb-8">
          Whether you have the edge or you&apos;re looking for it.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/genius" className="btn-genius !px-8 !py-3 !text-base !rounded-xl">
            Sell Signals
          </Link>
          <Link href="/idiot" className="btn-idiot !px-8 !py-3 !text-base !rounded-xl">
            Buy Signals
          </Link>
        </div>
      </section>
    </div>
  );
}
