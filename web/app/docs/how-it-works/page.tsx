import Link from "next/link";

export const metadata = {
  title: "How Djinn Works | Docs",
  description: "The Djinn protocol in 5 minutes: signals, MPC, settlement, and track records.",
};

const steps = [
  {
    number: "1",
    title: "Genius creates a signal",
    description:
      "A Genius has an analytical prediction (e.g., \"Celtics -4.5\"). They encrypt it locally in their browser, hide it among 9 decoy lines, and commit the encrypted blob on-chain. The real pick's index is split across validators using Shamir's Secret Sharing. Nobody, not even Djinn, can see which line is real.",
    color: "genius",
  },
  {
    number: "2",
    title: "Idiot browses and purchases",
    description:
      "An Idiot browses available signals by sport, checks the Genius's track record, and decides to buy. They deposit USDC into the Escrow contract, and the purchase triggers an MPC availability check: validators jointly verify the real pick is still available at sportsbooks, without revealing which line it is. If available, the Idiot receives encrypted key shares to decrypt the signal.",
    color: "idiot",
  },
  {
    number: "3",
    title: "The game happens",
    description:
      "The sporting event plays out. Validators independently query official sports data sources to determine the outcome. No human judgment is involved. The protocol waits for the game to finish before proceeding.",
    color: "slate",
  },
  {
    number: "4",
    title: "MPC settlement",
    description:
      "After every 10 signals between a Genius-Idiot pair, validators compute an aggregate Quality Score using secure multi-party computation. Each validator independently calculates the score from the encrypted data and submits their result on-chain. When 2/3+ validators agree, settlement is finalized automatically.",
    color: "slate",
  },
  {
    number: "5",
    title: "USDC moves",
    description:
      "If the Quality Score is positive (the Genius performed well), they keep the fees. If negative (poor performance), the Genius's collateral is slashed: the Idiot gets a USDC refund and Djinn Credits for any excess damages. The Genius can claim their earned fees after a 48-hour dispute window.",
    color: "slate",
  },
  {
    number: "6",
    title: "Track record builds",
    description:
      "Every settlement is recorded on-chain. A Genius's track record is the complete, immutable history of their Quality Scores. No one can fake it, inflate it, or hide bad results. Buyers can verify any Genius's full history by reading the Base blockchain directly.",
    color: "slate",
  },
];

export default function HowItWorks() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-10">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-slate-900 mb-3">How Djinn Works</h1>
      <p className="text-lg text-slate-500 mb-12">
        From prediction to settlement in 6 steps. The entire flow is encrypted,
        decentralized, and settled in USDC.
      </p>

      <div className="space-y-8">
        {steps.map((step) => (
          <div key={step.number} className="flex gap-5">
            <div
              className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${
                step.color === "genius"
                  ? "bg-genius-100 text-genius-700"
                  : step.color === "idiot"
                    ? "bg-idiot-100 text-idiot-700"
                    : "bg-slate-100 text-slate-600"
              }`}
            >
              {step.number}
            </div>
            <div className="pt-1">
              <h3 className="font-semibold text-slate-900 mb-1">{step.title}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Key properties */}
      <div className="mt-14 pt-8 border-t border-slate-200">
        <h2 className="text-xl font-semibold text-slate-900 mb-6">Key properties</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <h3 className="font-semibold text-slate-900 mb-1">Signal secrecy</h3>
            <p className="text-sm text-slate-600">
              Predictions are encrypted client-side. The real pick is hidden among 9
              decoys. The index is Shamir-split across validators. No single party ever
              sees the plaintext pick.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 mb-1">Verifiable track records</h3>
            <p className="text-sm text-slate-600">
              Every settlement is on-chain. Quality Scores are computed by MPC and
              verified by 2/3+ validators. Track records are immutable and publicly
              auditable.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 mb-1">Non-custodial</h3>
            <p className="text-sm text-slate-600">
              All funds are held in auditable smart contracts on Base, never by Djinn.
              Deposits, withdrawals, and settlements are executed by code, not people.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 mb-1">Decentralized infrastructure</h3>
            <p className="text-sm text-slate-600">
              Validators and miners run on Bittensor (Subnet 103). Settlement consensus
              requires 2/3+ independent validators. No single point of failure or trust.
            </p>
          </div>
        </div>
      </div>

      {/* CTAs */}
      <div className="mt-12 flex flex-wrap gap-4">
        <Link
          href="/genius"
          className="rounded-lg border-2 border-genius-200 px-5 py-2.5 text-sm font-semibold text-genius-700 hover:bg-genius-50 transition-colors"
        >
          Start as a Genius
        </Link>
        <Link
          href="/idiot"
          className="rounded-lg border-2 border-idiot-200 px-5 py-2.5 text-sm font-semibold text-idiot-700 hover:bg-idiot-50 transition-colors"
        >
          Start as an Idiot
        </Link>
        <Link
          href="/docs/api"
          className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
        >
          API Reference
        </Link>
      </div>

      <div className="mt-8 pb-4">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>
    </div>
  );
}
