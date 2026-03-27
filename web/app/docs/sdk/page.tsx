import Link from "next/link";

export const metadata = {
  title: "SDK | Djinn Docs",
  description:
    "Client-side TypeScript SDK for Djinn: encryption, Shamir splitting, decoy generation, and wallet integration.",
};

export default function SdkDocs() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-slate-900 mb-3">Client SDK</h1>
      <p className="text-lg text-slate-500 mb-8">
        The Djinn SDK handles client-side cryptography so your plaintext pick never
        leaves your device. The API only ever sees encrypted data.
      </p>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-8">
        <p className="text-sm text-amber-800">
          <strong>Coming soon.</strong> The SDK is being extracted from the web client
          into a standalone package. In the meantime, developers can reference the
          encryption and Shamir logic in the{" "}
          <a
            href="https://github.com/djinn-inc/djinn/tree/main/web/lib/crypto.ts"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            web/lib/crypto.ts
          </a>{" "}
          source file.
        </p>
      </div>

      <h2 className="text-xl font-semibold text-slate-900 mb-4">What the SDK does</h2>

      <div className="space-y-6 mb-12">
        <div>
          <h3 className="font-semibold text-slate-900 mb-1">1. Encryption</h3>
          <p className="text-sm text-slate-600">
            Generates a random AES-256-GCM key, encrypts the 10-line signal blob (1 real
            pick + 9 decoys), and produces a commitment hash for on-chain submission. The
            plaintext pick exists only in the Genius&apos;s browser memory during signal
            creation.
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-1">2. Decoy generation</h3>
          <p className="text-sm text-slate-600">
            Generates 9 plausible decoy lines matching the sport and market type. Decoys
            are indistinguishable from the real pick to anyone without the Shamir secret.
            The API can suggest decoys via{" "}
            <code className="text-xs bg-slate-100 px-1 rounded">POST /api/genius/signal/prepare</code>,
            or the SDK can generate them locally.
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-1">3. Shamir splitting</h3>
          <p className="text-sm text-slate-600">
            Splits the real pick index (which of the 10 lines is real) into n shares
            using Shamir&apos;s Secret Sharing over a prime field. Reconstruction requires
            k-of-n shares. Each share is encrypted with the corresponding validator&apos;s
            public key before distribution.
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-1">4. Key share encryption</h3>
          <p className="text-sm text-slate-600">
            The AES encryption key is also Shamir-split and each key share is encrypted
            for its target validator. This ensures no single validator can decrypt the
            signal content. Only the buyer (after purchasing) receives enough shares to
            reconstruct the key and decrypt.
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-1">5. On-chain commitment</h3>
          <p className="text-sm text-slate-600">
            Constructs the <code className="text-xs bg-slate-100 px-1 rounded">commitSignal()</code>{" "}
            transaction for the SignalCommitment contract: encrypted blob, commitment hash,
            sport, pricing parameters, and expiry. The SDK prepares the calldata; the
            wallet signs and submits.
          </p>
        </div>
      </div>

      <h2 className="text-xl font-semibold text-slate-900 mb-4">Signal creation flow</h2>

      <pre className="text-xs font-mono bg-slate-900 text-green-400 rounded-lg p-4 overflow-x-auto mb-8">
{`import { DjinnSDK } from "@djinn/sdk";  // coming soon

const sdk = new DjinnSDK({ rpcUrl: "https://mainnet.base.org" });

// 1. Prepare: get validator keys and decoy suggestions
const prep = await sdk.prepareSignal({
  sport: "basketball_nba",
  eventId: "abc123",
  maxNotional: 1000,
  feeBps: 500,
});

// 2. Encrypt: pick + decoys, locally
const encrypted = sdk.encryptSignal({
  pick: "Celtics -4.5 (-110)",  // never leaves this device
  decoys: prep.suggestedDecoys,
  validatorPubkeys: prep.validatorPubkeys,
  shamirN: prep.shamirN,
  shamirK: prep.shamirK,
});

// 3. Commit on-chain
const commitTx = await sdk.commitSignal({
  encryptedBlob: encrypted.blob,
  commitHash: encrypted.hash,
  sport: "basketball_nba",
  feeBps: 500,
  slaBps: 15000,
  maxNotional: 1000,
  expiresAt: prep.expiresAt,
});

// 4. Distribute shares to validators
await sdk.distributeShares({
  signalId: commitTx.signalId,
  encryptedShares: encrypted.shares,
});`}
      </pre>

      <h2 className="text-xl font-semibold text-slate-900 mb-4">Security properties</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-1">Plaintext never leaves client</h3>
          <p className="text-xs text-slate-600">
            The real pick is encrypted in-browser. The API, validators, and Djinn servers
            never see it.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-1">Threshold decryption</h3>
          <p className="text-xs text-slate-600">
            k-of-n Shamir sharing means no single validator can reconstruct the key or
            the real index. Collusion of k-1 validators reveals nothing.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-1">Commitment binding</h3>
          <p className="text-xs text-slate-600">
            The on-chain commit hash binds the encrypted blob. The Genius cannot change
            the pick after committing.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 text-sm mb-1">Verifiable open-source</h3>
          <p className="text-xs text-slate-600">
            All encryption code is open-source. Anyone can audit the client to verify
            that plaintext picks are handled correctly.
          </p>
        </div>
      </div>

      <div className="mt-8 pb-4">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>
    </div>
  );
}
