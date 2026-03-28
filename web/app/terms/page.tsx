import Link from "next/link";

export const metadata = {
  title: "Terms of Service | Djinn",
};

export default function Terms() {
  return (
    <div className="max-w-3xl mx-auto prose prose-slate prose-sm">
      <h1 className="text-3xl font-bold text-slate-900 mb-2">Terms of Service</h1>
      <p className="text-sm text-slate-400 mb-8">Last updated: March 27, 2026</p>

      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the Djinn
        Protocol (&ldquo;Djinn,&rdquo; &ldquo;we,&rdquo; &ldquo;our&rdquo;), including
        the website at djinn.gg, the Djinn web application, associated APIs, and all
        smart contracts deployed on the Base blockchain. By connecting a wallet, using
        the API, or otherwise interacting with Djinn, you agree to these Terms. If you
        do not agree, do not use the service.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        1. What Djinn Is
      </h2>
      <p>
        Djinn is a decentralized <strong>information marketplace</strong>. Analysts
        (&ldquo;Geniuses&rdquo;) sell encrypted analytical predictions as an information
        service. Buyers (&ldquo;Idiots&rdquo;) purchase access to those predictions. The
        transaction is a service-level agreement: pay for analytical quality, receive
        compensation if quality is poor.
      </p>
      <p>
        Djinn follows the same structure as a consulting engagement, research subscription,
        or investment newsletter.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        2. What Djinn Is Not
      </h2>
      <p>Djinn is <strong>not</strong> a sportsbook, exchange, broker, or gambling platform. Specifically, Djinn does not:</p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>Accept, facilitate, intermediate, or process any wager or bet</li>
        <li>Match bettors with one another</li>
        <li>Set, quote, or offer odds on any sporting event</li>
        <li>Take any position on any sporting event</li>
        <li>Know whether any user places a bet based on a purchased signal</li>
        <li>Offer, sell, or distribute securities, derivatives, or financial instruments</li>
        <li>Provide custody, clearing, or settlement services for any financial product</li>
      </ul>
      <p>
        These are not policy commitments. They are architectural constraints enforced by
        protocol design. All signal content is encrypted client-side, and the encryption
        key is split across independent validators via Shamir&apos;s Secret Sharing. Djinn
        structurally cannot view signal content. Anyone can verify this from the{" "}
        <a
          href="https://github.com/djinn-inc/djinn"
          target="_blank"
          rel="noopener noreferrer"
          className="text-slate-900 underline"
        >
          open-source client code
        </a>.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        3. Eligibility and Restricted Jurisdictions
      </h2>
      <p>
        You must be at least 18 years old (or the age of majority in your jurisdiction)
        to use Djinn. You are responsible for ensuring that your use of Djinn complies
        with all laws applicable to you in your jurisdiction.
      </p>
      <p>
        <strong>You may not use Djinn if you are located in, a resident of, or a national
        of any jurisdiction subject to comprehensive sanctions by the United States,</strong>{" "}
        including but not limited to: Cuba, Iran, North Korea, Syria, the Crimea, Donetsk,
        and Luhansk regions of Ukraine, or any other jurisdiction designated by the U.S.
        Office of Foreign Assets Control (OFAC). This list may be updated without notice
        as sanctions designations change.
      </p>
      <p>
        You represent and warrant that you are not (a) listed on any U.S. government list
        of prohibited or restricted parties, including the Specially Designated Nationals
        (SDN) list maintained by OFAC, (b) located in or a national of a sanctioned
        jurisdiction, or (c) otherwise prohibited from using the service under applicable
        export control or sanctions laws.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        4. Accounts and Wallets
      </h2>
      <p>
        You connect to Djinn using a blockchain wallet (e.g. Coinbase Smart Wallet,
        MetaMask, or any WalletConnect-compatible wallet). You are solely responsible for
        the security of your wallet, private keys, and any credentials associated with
        your account. Djinn never has access to your private keys.
      </p>
      <p>
        If you lose access to your wallet, you may lose access to your funds and signal
        history. Djinn cannot recover private keys on your behalf.
      </p>
      <p>
        You may not create or use multiple accounts to circumvent rate limits, evade
        enforcement actions, or manipulate the platform. Each natural person or legal
        entity should use a single primary wallet address.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        5. USDC and Platform Balances
      </h2>
      <p>
        Idiots deposit USDC into the Djinn smart contracts to maintain a platform
        balance for purchasing signals. Geniuses deposit USDC as collateral backing
        their service-level agreements. All deposits and withdrawals are executed by
        smart contracts on the Base blockchain and are subject to blockchain transaction
        finality.
      </p>
      <p>
        Djinn does not custody user funds. Funds are held in auditable, open-source smart
        contracts on the Base blockchain. A 0.5% protocol fee is collected on each
        purchase and transferred to the protocol treasury. During active settlement
        periods, collateral withdrawals may be temporarily frozen to ensure accurate
        accounting. This freeze typically resolves within one transaction cycle.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        6. Signals and Service-Level Agreements
      </h2>
      <p>
        When a Genius creates a signal, they set a fee percentage and SLA Multiplier
        (damages rate). When an Idiot purchases a signal, the fee is automatically
        deducted from their platform balance, and the Genius&apos;s collateral is locked
        proportionally.
      </p>
      <p>
        After every 10 signals between a Genius-Idiot pair, a cryptographic audit
        computes a Quality Score using secure multi-party computation (MPC). If the
        Quality Score is negative, the Genius&apos;s collateral is slashed: the Idiot
        receives a USDC refund (up to fees paid) plus Djinn Credits for any excess
        damages. If the Quality Score is positive, the Genius retains the fees.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        7. Djinn Credits
      </h2>
      <p>
        Djinn Credits are non-transferable, non-cashable platform credits that function
        as a discount on future signal purchases. Credits do not expire but carry no cash
        value outside the platform. A buyer can never extract more USDC than they
        deposited. Credits are analogous to store credit after a refund.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        8. No Financial or Betting Advice
      </h2>
      <p>
        Nothing on Djinn constitutes financial advice, investment advice, or a
        recommendation to place any wager. Signals are analytical predictions sold as
        information. What you do with purchased information is entirely your decision and
        your responsibility.
      </p>
      <p>
        Past performance of any Genius, as reflected in their Quality Score or track
        record, does not guarantee future results.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        9. Risks
      </h2>
      <p>You acknowledge and accept the following risks:</p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>
          <strong>Smart contract risk:</strong> While audited, smart contracts may contain
          vulnerabilities. Funds deposited into smart contracts are subject to this risk.
          All platform contracts use upgradeable proxy patterns. Contract logic may be
          updated through a governance timelock process. While this enables bug fixes and
          improvements, it means contract behavior can change after you deposit funds.
        </li>
        <li>
          <strong>Blockchain risk:</strong> Transactions on the Base blockchain are
          irreversible. Network congestion, outages, or forks may affect the protocol.
        </li>
        <li>
          <strong>Signal quality risk:</strong> Geniuses may underperform. The SLA
          mechanism provides structured compensation but does not eliminate the risk of
          purchasing poor-quality analysis.
        </li>
        <li>
          <strong>Regulatory risk:</strong> The legal status of information marketplaces,
          cryptocurrency, and related technologies varies by jurisdiction and may change.
        </li>
        <li>
          <strong>Protocol risk:</strong> The Djinn protocol depends on a decentralized
          validator network for MPC computation and outcome verification. Validator
          downtime, consensus failures, or network partitions may delay or affect
          settlement. Signal purchases and decryption depend on validators performing
          secure multi-party computation. If insufficient validators are online, signal
          purchases may temporarily fail or take longer than usual.
        </li>
        <li>
          <strong>Stablecoin risk:</strong> USDC is issued by Circle. Its value, liquidity,
          and redeemability are subject to Circle&apos;s operations and applicable regulations.
        </li>
      </ul>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        10. Prohibited Conduct
      </h2>
      <p>You agree not to use Djinn to:</p>

      <h3 className="text-base font-semibold text-slate-800 mt-6 mb-2">
        10a. General Prohibitions
      </h3>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>Violate any applicable local, state, national, or international law or regulation</li>
        <li>Attempt to manipulate track records, Quality Scores, or audit outcomes</li>
        <li>Interfere with the operation of the smart contracts, validators, or miners</li>
        <li>Use automated systems to interact with Djinn in a way that degrades service for other users</li>
        <li>Misrepresent your identity, qualifications, or jurisdiction</li>
        <li>Circumvent any access restrictions, geo-blocking, or rate limits</li>
        <li>Reverse-engineer, decompile, or disassemble the protocol for the purpose of exploiting vulnerabilities (responsible security disclosure is permitted and encouraged)</li>
      </ul>

      <h3 className="text-base font-semibold text-slate-800 mt-6 mb-2">
        10b. Financial Crime Prohibitions
      </h3>
      <p>You specifically agree not to use Djinn to:</p>
      <ul className="list-disc list-inside space-y-1 text-slate-600">
        <li>
          <strong>Launder money</strong> or engage in any activity designed to disguise the
          source, ownership, or destination of funds, including structuring transactions to
          avoid reporting thresholds
        </li>
        <li>
          <strong>Finance terrorism</strong> or provide material support to any person or
          organization designated as a terrorist or terrorist organization by any government
        </li>
        <li>
          <strong>Evade sanctions</strong> or facilitate transactions involving sanctioned
          persons, entities, or jurisdictions
        </li>
        <li>
          <strong>Engage in insider trading</strong> or use material non-public information
          (MNPI) obtained through privileged access to teams, players, officials, leagues,
          or sportsbooks to create or influence signals. This includes but is not limited
          to: injury information not yet public, disciplinary actions, lineup decisions,
          officiating assignments, or any other information that would provide an unfair
          informational advantage
        </li>
        <li>
          <strong>Manipulate sporting events</strong> or use Djinn in connection with
          match-fixing, point-shaving, or any scheme to influence the outcome of a
          sporting event
        </li>
        <li>
          <strong>Engage in market manipulation</strong> including wash trading (buying your
          own signals to inflate track records), coordinated trading to manipulate Quality
          Scores, or any scheme to deceive other users about a Genius&apos;s true performance
        </li>
        <li>
          <strong>Engage in fraud</strong> including creating signals with no analytical
          basis for the purpose of extracting fees, impersonating other Geniuses, or
          misrepresenting signal methodology
        </li>
      </ul>

      <h3 className="text-base font-semibold text-slate-800 mt-6 mb-2">
        10c. Enforcement
      </h3>
      <p>
        Djinn reserves the right to restrict access, block wallet addresses, and
        cooperate with law enforcement agencies in the investigation of suspected
        violations. Because Djinn is a decentralized protocol, some enforcement actions
        may be limited to the web application interface while on-chain contracts remain
        permissionless.
      </p>
      <p>
        If you become aware of any prohibited conduct by another user, please report it
        through our contact channels.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        11. API Access
      </h2>
      <p>
        Djinn provides a public API for programmatic access to the protocol. API users
        are subject to the same Terms, including all prohibited conduct provisions. API
        access may be rate-limited to protect service availability. Abuse of the API
        (including but not limited to denial-of-service patterns, scraping for
        competitive intelligence, or circumventing access controls) may result in
        permanent revocation of API access.
      </p>
      <p>
        Developers who build applications on top of the Djinn API are responsible for
        ensuring their applications comply with these Terms and all applicable laws.
        Djinn is not responsible for third-party applications built using the API.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        12. Intellectual Property
      </h2>
      <p>
        The Djinn Protocol is open-source software. The Djinn name, logo, and brand
        assets are the property of Djinn Inc. The open-source license governs the code;
        it does not grant rights to the Djinn brand.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        13. Indemnification
      </h2>
      <p>
        You agree to indemnify, defend, and hold harmless Djinn Inc., its officers,
        directors, employees, agents, and contributors from and against any claims,
        liabilities, damages, losses, costs, or expenses (including reasonable
        attorneys&apos; fees) arising from: (a) your use of the protocol, (b) your
        violation of these Terms, (c) your violation of any applicable law or regulation,
        or (d) any content or signals you create, publish, or distribute through the
        protocol.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        14. Limitation of Liability
      </h2>
      <p>
        To the maximum extent permitted by law, Djinn Inc. and its contributors shall not
        be liable for any indirect, incidental, special, consequential, or punitive
        damages, including loss of funds, loss of profits, loss of data, or business
        interruption, arising from your use of the protocol, whether based on warranty,
        contract, tort, or any other legal theory, and whether or not Djinn Inc. has been
        advised of the possibility of such damages.
      </p>
      <p>
        In no event shall the total liability of Djinn Inc. exceed the amount of fees
        you have paid to the protocol in the twelve (12) months preceding the claim.
      </p>
      <p>
        Djinn is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without
        warranties of any kind, whether express, implied, or statutory, including but not
        limited to warranties of merchantability, fitness for a particular purpose, and
        non-infringement.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        15. Dispute Resolution and Arbitration
      </h2>
      <p>
        <strong>Please read this section carefully. It affects your legal rights.</strong>
      </p>
      <p>
        Any dispute, claim, or controversy arising out of or relating to these Terms or
        your use of Djinn (&ldquo;Dispute&rdquo;) shall be resolved through binding
        individual arbitration administered by the American Arbitration Association (AAA)
        under its Commercial Arbitration Rules. The arbitration shall take place in
        Wilmington, Delaware, or at a location mutually agreed upon by the parties.
      </p>
      <p>
        <strong>Class action waiver:</strong> You agree that any Dispute shall be
        resolved only on an individual basis and not as part of any class, consolidated,
        or representative action. The arbitrator may not consolidate more than one
        person&apos;s claims and may not preside over any form of class or representative
        proceeding.
      </p>
      <p>
        <strong>Small claims exception:</strong> Either party may bring an individual
        action in small claims court for Disputes within the court&apos;s jurisdictional
        limits.
      </p>
      <p>
        <strong>Opt-out:</strong> You may opt out of this arbitration provision by
        sending written notice to legal@djinn.gg within 30 days of first using Djinn.
        The notice must include your wallet address and a statement that you wish to opt
        out of arbitration. If you opt out, Disputes will be resolved in the state or
        federal courts located in Wilmington, Delaware.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        16. Governing Law
      </h2>
      <p>
        These Terms are governed by the laws of the State of Delaware, United States,
        without regard to conflict of law principles.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        17. Severability
      </h2>
      <p>
        If any provision of these Terms is held to be unenforceable, that provision will
        be modified to the minimum extent necessary to make it enforceable, and the
        remaining provisions will continue in full force and effect.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        18. Entire Agreement
      </h2>
      <p>
        These Terms, together with the Privacy Policy, constitute the entire agreement
        between you and Djinn Inc. regarding your use of the protocol and supersede all
        prior agreements and understandings.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        19. Modifications
      </h2>
      <p>
        We may update these Terms from time to time. Material changes will be posted on
        this page with an updated date. Continued use of Djinn after changes constitutes
        acceptance of the revised Terms. For material changes that significantly affect
        your rights, we will make reasonable efforts to provide advance notice through the
        web application.
      </p>

      <h2 className="text-xl font-semibold text-slate-900 mt-10 mb-3">
        20. Contact
      </h2>
      <p>
        For questions about these Terms, reach us at{" "}
        <a href="mailto:legal@djinn.gg" className="text-slate-900 underline">
          legal@djinn.gg
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
