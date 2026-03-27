import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | Djinn",
};

export default function Privacy() {
  return (
    <div className="max-w-3xl mx-auto prose prose-slate prose-sm">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-slate-400 mb-8">Last updated: March 27, 2026</p>

      <p>
        This Privacy Policy describes how the Djinn Protocol (&ldquo;Djinn,&rdquo;
        &ldquo;we,&rdquo; &ldquo;our&rdquo;) handles information when you use the
        website at djinn.gg, the Djinn web application, and associated APIs. Djinn is
        designed to collect as little data as possible.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        1. Information We Do Not Collect
      </h2>
      <p>
        Djinn is a decentralized protocol. By design, we <strong>do not</strong> collect,
        store, or have access to:
      </p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>
          <strong>Signal content:</strong> All predictions are encrypted client-side
          before leaving your browser. Djinn structurally cannot view signal content.
        </li>
        <li>
          <strong>Private keys or seed phrases:</strong> Your wallet keys never leave your
          device or wallet provider.
        </li>
        <li>
          <strong>Betting activity:</strong> Djinn has no data path connecting signal
          purchases to any wager placed at any sportsbook.
        </li>
        <li>
          <strong>Individual signal outcomes:</strong> Audit settlements use secure
          multi-party computation (MPC). The smart contracts verify aggregate Quality
          Scores without learning which individual signals were favorable or unfavorable.
        </li>
      </ul>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        2. Information Stored On-Chain
      </h2>
      <p>
        The following information is recorded on the Base blockchain as part of normal
        protocol operation. Blockchain data is public, permanent, and not controlled
        by Djinn:
      </p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>Wallet addresses associated with signals and purchases</li>
        <li>Encrypted signal blobs and commitment hashes</li>
        <li>Signal metadata (sport, pricing parameters, expiration, decoy lines)</li>
        <li>USDC deposit and withdrawal transactions</li>
        <li>Audit results and aggregate Quality Scores</li>
        <li>MPC-verified settlement records</li>
      </ul>
      <p>
        This data is inherent to blockchain-based protocols and cannot be deleted.
        It is publicly accessible to anyone reading the Base blockchain, with or
        without Djinn.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        3. Information We Process
      </h2>
      <p>
        To operate the web application and enforce our Terms of Service, we process
        the following data:
      </p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>
          <strong>IP addresses:</strong> Used for geographic access controls (to enforce
          sanctions compliance) and rate limiting. IP addresses are not stored
          persistently and are not linked to wallet addresses.
        </li>
        <li>
          <strong>API request metadata:</strong> Request timestamps, endpoints accessed,
          and response codes for rate limiting and abuse prevention. This data is retained
          for up to 30 days.
        </li>
      </ul>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        4. Wallet Connection
      </h2>
      <p>
        Djinn uses standard wallet connection protocols (WalletConnect, Coinbase Smart
        Wallet, MetaMask) for authentication. When you connect your wallet, no personal
        information is collected by Djinn. Your wallet address is used solely to identify
        your on-chain activity. If you use Coinbase Smart Wallet, Coinbase processes
        wallet creation and identity verification data under its own privacy policy.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        5. Local Storage
      </h2>
      <p>
        The Djinn web application uses your browser&apos;s local storage (not cookies)
        to store:
      </p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>Terms of Service acceptance status</li>
        <li>Cached signal data for performance (not a dependency; can be cleared)</li>
        <li>Wallet connection preferences</li>
      </ul>
      <p>
        Local storage data remains on your device and is not transmitted to any server.
        You can clear it at any time through your browser settings.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        6. Cookies
      </h2>
      <p>
        The Djinn website does not set first-party cookies. Our wallet connection
        providers may set cookies necessary for authentication functionality. We do not
        use cookies for analytics, advertising, or tracking.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        7. Analytics and Tracking
      </h2>
      <p>
        Djinn does not use analytics services (Google Analytics, Mixpanel, etc.).
        We do not track your browsing behavior, page views, or interactions. Our
        hosting provider (Vercel) may collect basic server logs (IP addresses, request
        timestamps) as part of standard web hosting. These logs are subject to{" "}
        <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-slate-900 underline">
          Vercel&apos;s privacy policy
        </a>.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        8. Third-Party Services
      </h2>
      <p>Djinn integrates with the following third-party services:</p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>
          <strong>Coinbase Smart Wallet / WalletConnect:</strong> Wallet connection,
          authentication, and optional gas sponsorship
        </li>
        <li>
          <strong>Base (Coinbase L2):</strong> Blockchain for smart contract execution
        </li>
        <li>
          <strong>The Graph:</strong> Decentralized indexing of public on-chain data
        </li>
        <li>
          <strong>Bittensor:</strong> Decentralized validator and miner network for
          MPC computation and attestation
        </li>
        <li>
          <strong>Vercel:</strong> Website and API hosting
        </li>
        <li>
          <strong>The Odds API:</strong> Sports odds data (no user data is shared with
          this provider)
        </li>
      </ul>
      <p>
        Each service operates under its own privacy policy. Djinn does not control the
        data practices of these providers.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        9. Data Retention
      </h2>
      <p>
        Djinn does not operate servers that store persistent user data. On-chain data is
        permanent and immutable by nature. API request metadata (for rate limiting) is
        retained for up to 30 days. Local storage data persists until you clear it.
        Wallet providers retain their own data per their respective retention policies.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        10. Your Rights
      </h2>
      <p>
        Because Djinn collects minimal data, most traditional data rights (access,
        correction, deletion) apply primarily to data held by your wallet provider.
        Contact your wallet provider directly for data requests.
      </p>
      <p>
        On-chain data cannot be modified or deleted due to the immutable nature of
        blockchain technology. This is a fundamental characteristic of decentralized
        protocols, not a policy choice.
      </p>
      <p>
        If you are located in the European Economic Area, United Kingdom, or another
        jurisdiction with data protection laws, you may have additional rights regarding
        the limited data we process (such as IP addresses for geo-blocking). To exercise
        these rights, contact us at the address below.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        11. International Data Transfers
      </h2>
      <p>
        The Djinn web application is hosted on Vercel&apos;s global infrastructure. API
        requests may be processed in any region where Vercel operates. The Base
        blockchain is a global, decentralized network without a single geographic
        location. By using Djinn, you consent to the processing of the limited data
        described above in any jurisdiction where our infrastructure providers operate.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        12. Children
      </h2>
      <p>
        Djinn is not intended for anyone under 18 years of age. We do not knowingly
        collect information from children.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        13. Changes
      </h2>
      <p>
        We may update this Privacy Policy from time to time. Changes will be posted on
        this page with an updated date.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        14. Contact
      </h2>
      <p>
        For privacy questions, reach us at{" "}
        <a href="mailto:privacy@djinn.gg" className="text-slate-900 underline">
          privacy@djinn.gg
        </a>,{" "}
        <a href="https://x.com/djinn_gg" target="_blank" rel="noopener noreferrer" className="text-slate-900 underline">
          @djinn_gg on X
        </a>, or through our{" "}
        <a href="https://discord.com/channels/799672011265015819/1465362098971345010" target="_blank" rel="noopener noreferrer" className="text-slate-900 underline">
          Discord channel
        </a>.
      </p>

      <div className="mt-12 pt-8 border-t border-slate-200">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Djinn
        </Link>
      </div>
    </div>
  );
}
