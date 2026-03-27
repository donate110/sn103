import Link from "next/link";

export const metadata = {
  title: "Documentation | Djinn",
  description:
    "Learn how to use Djinn as a Genius (sell predictions) or an Idiot (buy signals). API reference, SDK docs, and quickstart guides.",
};

const sections = [
  {
    title: "How Djinn Works",
    href: "/docs/how-it-works",
    description: "The protocol in 5 minutes: signals, MPC, settlement, track records.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    title: "API Reference",
    href: "/docs/api",
    description: "REST endpoints for genius and idiot operations. Programmatic access to signals, purchases, and settlement.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
  },
  {
    title: "SDK",
    href: "/docs/sdk",
    description: "Client-side TypeScript SDK for encryption, Shamir splitting, and wallet integration.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
  },
  {
    title: "Smart Contracts",
    href: "/docs/contracts",
    description: "Contract addresses, ABIs, and on-chain interaction guides for Base.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

export default function Docs() {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-12">
        <h1 className="text-3xl font-bold text-slate-900 mb-3">Documentation</h1>
        <p className="text-lg text-slate-500">
          Djinn is a decentralized information marketplace for sports predictions.
          Geniuses sell encrypted analytical signals. Idiots buy access. Track records
          are cryptographically verifiable. Settlement is in USDC on Base.
        </p>
      </div>

      {/* 2x2 Table: Human/Computer x Genius/Idiot */}
      <div className="mb-14">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">
          Choose your path
        </h2>
        <div className="grid grid-cols-3 gap-0 border border-slate-200 rounded-xl overflow-hidden">
          {/* Header row */}
          <div className="bg-slate-50 p-4 border-b border-r border-slate-200" />
          <div className="bg-slate-50 p-4 border-b border-r border-slate-200 text-center">
            <div className="flex items-center justify-center gap-2">
              <div className="w-6 h-6 rounded-full bg-genius-100 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-genius-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                </svg>
              </div>
              <span className="font-semibold text-slate-900">Genius</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">Sell predictions</p>
          </div>
          <div className="bg-slate-50 p-4 border-b border-slate-200 text-center">
            <div className="flex items-center justify-center gap-2">
              <div className="w-6 h-6 rounded-full bg-idiot-100 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-idiot-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
                </svg>
              </div>
              <span className="font-semibold text-slate-900">Idiot</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">Buy signals</p>
          </div>

          {/* Human row */}
          <div className="bg-slate-50 p-4 border-b border-r border-slate-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
            <span className="font-semibold text-slate-700">Human</span>
          </div>
          <Link
            href="/genius"
            className="p-4 border-b border-r border-slate-200 hover:bg-genius-50 transition-colors group"
          >
            <p className="font-medium text-slate-900 group-hover:text-genius-700">
              Web App
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Create signals, manage collateral, track earnings through the UI
            </p>
          </Link>
          <Link
            href="/idiot"
            className="p-4 border-b border-slate-200 hover:bg-idiot-50 transition-colors group"
          >
            <p className="font-medium text-slate-900 group-hover:text-idiot-700">
              Web App
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Browse signals, buy picks, view settlements through the UI
            </p>
          </Link>

          {/* Computer row */}
          <div className="bg-slate-50 p-4 border-r border-slate-200 flex items-center gap-2">
            <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
            </svg>
            <span className="font-semibold text-slate-700">Computer</span>
          </div>
          <Link
            href="/docs/api"
            className="p-4 border-r border-slate-200 hover:bg-genius-50 transition-colors group"
          >
            <p className="font-medium text-slate-900 group-hover:text-genius-700">
              API + SDK
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Automate signal posting from models, bots, or agent frameworks
            </p>
          </Link>
          <Link
            href="/docs/api"
            className="p-4 hover:bg-idiot-50 transition-colors group"
          >
            <p className="font-medium text-slate-900 group-hover:text-idiot-700">
              API + SDK
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Build bots, LLM agents, or custom tools that buy signals programmatically
            </p>
          </Link>
        </div>
      </div>

      {/* Section cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="group rounded-xl border border-slate-200 bg-white p-6 hover:border-slate-300 hover:shadow-md transition-all"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                {section.icon}
              </div>
              <h3 className="font-semibold text-slate-900">{section.title}</h3>
            </div>
            <p className="text-sm text-slate-500">{section.description}</p>
          </Link>
        ))}
      </div>

      {/* Quick links */}
      <div className="mt-12 pt-8 border-t border-slate-200">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Resources</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <a
            href="https://github.com/djinn-inc/djinn"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            Source Code
          </a>
          <a
            href="/whitepaper.pdf"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Whitepaper
          </a>
          <Link
            href="/network"
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-3 text-sm text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
            Network Status
          </Link>
        </div>
      </div>

      <div className="mt-8 pb-4">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-700 transition-colors">
          &larr; Back to Djinn
        </Link>
      </div>
    </div>
  );
}
