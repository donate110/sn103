import Image from "next/image";
import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-10rem)] px-4">
      {/* Logo + Wordmark */}
      <div className="flex items-center gap-4 sm:gap-5 mb-4">
        <Image
          src="/djinn-logo.png"
          alt="Djinn"
          width={72}
          height={72}
          className="w-16 h-16 sm:w-[72px] sm:h-[72px]"
          priority
        />
        <h1 className="text-5xl sm:text-6xl font-bold text-slate-900 font-wordmark tracking-wide">
          DJINN
        </h1>
      </div>

      {/* Subtitle */}
      <div className="flex flex-col items-center gap-1 mb-8">
        <p className="text-sm sm:text-base tracking-[0.25em] uppercase text-slate-400 font-light">
          The Genius-Idiot Network
        </p>
        <p className="text-base sm:text-lg text-slate-500 mt-1">
          Information{" "}
          <span className="font-bold text-slate-900 mx-1">&times;</span>{" "}
          Execution
        </p>
      </div>

      {/* Taglines */}
      <div className="text-center mb-10 sm:mb-14 space-y-1">
        <p className="text-slate-600">
          Buy intelligence you can <span className="font-semibold text-slate-900">trust</span>.
        </p>
        <p className="text-slate-600">
          Sell analysis you can <span className="font-semibold text-slate-900">prove</span>.
        </p>
        <p className="text-sm text-slate-400 italic mt-3">
          Signals stay secret forever. Even from us.
        </p>
      </div>

      {/* Separator */}
      <div className="flex items-center gap-4 w-full max-w-xs sm:max-w-lg mb-10 sm:mb-14">
        <div className="flex-1 h-px bg-slate-200" />
        <span className="text-xs text-slate-400 uppercase tracking-widest">Get started</span>
        <div className="flex-1 h-px bg-slate-200" />
      </div>

      {/* Two CTAs */}
      <div className="flex flex-row gap-4 sm:gap-6 w-full max-w-lg mb-12">
        {/* Genius — orange */}
        <Link
          href="/genius"
          className="flex-1 group rounded-xl sm:rounded-2xl border-2 border-genius-200 bg-white p-5 sm:p-8 text-center hover:border-genius-400 hover:shadow-lg hover:shadow-genius-100 transition-all"
        >
          <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-full bg-genius-100 flex items-center justify-center mx-auto mb-3 sm:mb-4 group-hover:bg-genius-200 transition-colors">
            <svg className="w-5 h-5 sm:w-7 sm:h-7 text-genius-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
            </svg>
          </div>
          <h2 className="text-base sm:text-xl font-bold text-slate-900 mb-0.5 sm:mb-1">
            I&apos;m a Genius
          </h2>
          <p className="text-xs sm:text-sm text-slate-500">
            Sell predictions
          </p>
        </Link>

        {/* Idiot — green */}
        <Link
          href="/idiot"
          className="flex-1 group rounded-xl sm:rounded-2xl border-2 border-idiot-200 bg-white p-5 sm:p-8 text-center hover:border-idiot-400 hover:shadow-lg hover:shadow-idiot-100 transition-all"
        >
          <div className="w-10 h-10 sm:w-14 sm:h-14 rounded-full bg-idiot-100 flex items-center justify-center mx-auto mb-3 sm:mb-4 group-hover:bg-idiot-200 transition-colors">
            <svg className="w-5 h-5 sm:w-7 sm:h-7 text-idiot-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
            </svg>
          </div>
          <h2 className="text-base sm:text-xl font-bold text-slate-900 mb-0.5 sm:mb-1">
            I&apos;m an Idiot
          </h2>
          <p className="text-xs sm:text-sm text-slate-500">
            Buy signals
          </p>
        </Link>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-400 mb-8">
        <Link href="/docs" className="hover:text-slate-600 transition-colors">Docs</Link>
        <Link href="/about" className="hover:text-slate-600 transition-colors">About</Link>
        <Link href="/leaderboard" className="hover:text-slate-600 transition-colors">Leaderboard</Link>
        <Link href="/network" className="hover:text-slate-600 transition-colors">Network</Link>
        <Link href="/attest" className="hover:text-slate-600 transition-colors">Attest</Link>
      </div>

      {/* Bottom links */}
      <div className="flex items-center gap-8 text-sm text-slate-400">
        <a
          href="https://x.com/djinn_gg"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-slate-600 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Follow
        </a>
        <a
          href="https://github.com/djinn-inc/djinn"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-slate-600 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          Source
        </a>
        <a
          href="/whitepaper.pdf"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:text-slate-600 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Whitepaper
        </a>
      </div>
    </div>
  );
}
