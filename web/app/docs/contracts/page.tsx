import Link from "next/link";

export const metadata = {
  title: "Smart Contracts | Djinn Docs",
  description:
    "Djinn smart contract addresses, ABIs, and interaction guides for Base chain.",
};

interface ContractInfo {
  name: string;
  description: string;
  address: string;
  functions: string[];
}

const contracts: ContractInfo[] = [
  {
    name: "SignalCommitment",
    description:
      "Stores encrypted signal blobs, commitment hashes, and signal metadata. Entry point for genius signal creation.",
    address: "0x4712479Ba57c9ED40405607b2B18967B359209C0",
    functions: [
      "commitSignal(bytes encryptedBlob, bytes32 commitHash, string sport, ...)",
      "cancelSignal(uint256 signalId)",
      "getSignal(uint256 signalId) view",
    ],
  },
  {
    name: "Escrow",
    description:
      "Holds idiot USDC deposits. Handles purchases, fee distribution, and buyer withdrawals.",
    address: "0xb43BA175a6784973eB3825acF801Cd7920ac692a",
    functions: [
      "deposit(uint256 amount)",
      "withdraw(uint256 amount)",
      "purchase(uint256 signalId, uint256 notional, uint256 odds)",
      "claimFees(address genius, address idiot)",
      "claimFeesBatch(address genius, address[] idiots)",
      "setOutcome(uint256 purchaseId, uint8 outcome)",
    ],
  },
  {
    name: "Collateral",
    description:
      "Holds genius USDC collateral backing their SLA commitments. Slashed on negative settlement.",
    address: "0x71F0a8c6BBFc4C83c5203807fAdd305B0C0F4C88",
    functions: [
      "deposit(uint256 amount)",
      "withdraw(uint256 amount)",
      "deposits(address) view",
      "locked(address) view",
    ],
  },
  {
    name: "Account",
    description:
      "Tracks genius-idiot pair cycles and purchase history for settlement grouping.",
    address: "0x4546354Dd32a613B76Abf530F81c8359e7cE440B",
    functions: [
      "recordOutcome(address genius, address idiot, ...)",
      "getPurchaseIds(address genius, address idiot) view",
      "getCurrentCycle(address genius, address idiot) view",
    ],
  },
  {
    name: "Audit",
    description:
      "Executes settlement: computes damages, slashes collateral, distributes refunds and credits.",
    address: "0xCa7e642FE31BA83a7a857644E8894c1B93a2a44E",
    functions: [
      "settleAuditSet(address genius, address idiot, int256 qualityScore, ...)",
      "finalizeAuditSet(address genius, address idiot)",
    ],
  },
  {
    name: "OutcomeVoting",
    description:
      "Validator consensus mechanism. Collects quality score votes and triggers settlement at 2/3+ agreement.",
    address: "0xAD534f4CAB13707BD4d65e4EF086A455e6A643e5",
    functions: [
      "submitVote(address genius, address idiot, int256 qualityScore, uint256 totalNotional)",
      "addValidator(address validator)",
      "removeValidator(address validator)",
    ],
  },
  {
    name: "CreditLedger",
    description:
      "Tracks non-transferable Djinn Credits (Tranche B damages). Credits discount future purchases.",
    address: "0xA65296cd11B65629641499024AD905FAcAB64C3E",
    functions: [
      "balanceOf(address) view",
      "award(address recipient, uint256 amount)",
      "consume(address buyer, uint256 amount)",
    ],
  },
  {
    name: "KeyRecovery",
    description:
      "Allows buyers to recover signal decryption keys if they lose their local data.",
    address: "0x496919DB9BC4590323cd019fE874311AC6116525",
    functions: [
      "storeRecoveryBlob(uint256 signalId, bytes blob)",
      "getRecoveryBlob(uint256 signalId) view",
    ],
  },
];

export default function ContractsDocs() {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>

      <h1 className="text-3xl font-bold text-slate-900 mb-3">Smart Contracts</h1>
      <p className="text-lg text-slate-500 mb-4">
        All Djinn contracts are deployed on Base as UUPS upgradeable proxies governed
        by a TimelockController (72-hour delay). Proxy addresses never change.
      </p>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-8">
        <p className="text-sm text-amber-800">
          <strong>Network:</strong> Base Sepolia (testnet). These addresses will change
          when mainnet contracts are deployed. The proxy pattern means mainnet addresses
          will be permanent once set.
        </p>
      </div>

      {/* Governance info */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-4 mb-8">
        <h3 className="font-semibold text-slate-900 mb-2">Governance</h3>
        <div className="space-y-2 text-sm text-slate-600">
          <p>
            <strong>TimelockController:</strong>{" "}
            <code className="text-xs bg-slate-200 px-1.5 py-0.5 rounded font-mono">
              0x37f41EFfa8492022afF48B9Ef725008963F14f79
            </code>
          </p>
          <p>
            All contract upgrades and configuration changes go through a 72-hour
            timelock. The deployer is the proposer; anyone can execute after the delay.
            Contracts have Pausable, UUPS upgradeToAndCall, and ReentrancyGuard.
          </p>
        </div>
      </div>

      {/* USDC */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-4 mb-10">
        <h3 className="font-semibold text-slate-900 mb-2">USDC</h3>
        <div className="space-y-2 text-sm text-slate-600">
          <p>
            <strong>Testnet (MockUSDC):</strong>{" "}
            <code className="text-xs bg-slate-200 px-1.5 py-0.5 rounded font-mono">
              0x00e8293b05dbD3732EF3396ad1483E87e7265054
            </code>
          </p>
          <p>
            <strong>Mainnet (Circle USDC):</strong>{" "}
            <code className="text-xs bg-slate-200 px-1.5 py-0.5 rounded font-mono">
              0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
            </code>
          </p>
          <p>
            Testnet uses a mintable MockUSDC for development. Mainnet will use
            Circle&apos;s official USDC on Base.
          </p>
        </div>
      </div>

      {/* Contract cards */}
      <div className="space-y-6">
        {contracts.map((c) => (
          <div key={c.name} className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 bg-slate-50 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">{c.name}</h3>
              <p className="text-sm text-slate-500 mt-1">{c.description}</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs text-slate-500 mb-1">Address (Base Sepolia)</p>
              <a
                href={`https://sepolia.basescan.org/address/${c.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-blue-600 hover:text-blue-500 break-all"
              >
                {c.address}
              </a>

              <p className="text-xs text-slate-500 mt-4 mb-2">Key functions</p>
              <div className="space-y-1">
                {c.functions.map((fn, i) => (
                  <code
                    key={i}
                    className="block text-xs font-mono text-slate-700 bg-slate-50 px-2 py-1 rounded"
                  >
                    {fn}
                  </code>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Integration note */}
      <div className="mt-10 rounded-lg border border-slate-200 bg-slate-50 px-5 py-4">
        <h3 className="font-semibold text-slate-900 mb-2">Integration</h3>
        <p className="text-sm text-slate-600">
          For programmatic interaction, use the{" "}
          <Link href="/docs/api" className="text-slate-900 underline font-medium">
            REST API
          </Link>{" "}
          rather than calling contracts directly. The API handles multi-step
          orchestration (MPC, validator coordination, share distribution) that would be
          complex to replicate. Direct contract calls are suitable for read-only queries
          and custom indexing.
        </p>
        <p className="text-sm text-slate-600 mt-2">
          Full ABIs are available in the{" "}
          <a
            href="https://github.com/djinn-inc/djinn/tree/main/contracts/out"
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-900 underline font-medium"
          >
            contracts/out
          </a>{" "}
          directory of the repository.
        </p>
      </div>

      <div className="mt-8 pb-4">
        <Link href="/docs" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Docs
        </Link>
      </div>
    </div>
  );
}
