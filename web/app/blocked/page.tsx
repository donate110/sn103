import Link from "next/link";

export const metadata = {
  title: "Region Unavailable | Djinn",
};

export default function Blocked() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-10rem)] px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-6">
        <svg
          className="w-8 h-8 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
          />
        </svg>
      </div>
      <h1 className="text-2xl font-bold text-slate-900 mb-3">
        Djinn is not available in your region
      </h1>
      <p className="text-slate-500 max-w-md mb-6">
        Due to regulatory restrictions, Djinn cannot be accessed from your current
        location. This restriction is based on your geographic region as determined
        by your IP address.
      </p>
      <p className="text-sm text-slate-400 max-w-md mb-8">
        If you believe this is an error, please contact us. For more information,
        see our{" "}
        <Link href="/terms" className="text-slate-600 underline">
          Terms of Service
        </Link>{" "}
        (Section 3: Eligibility and Restricted Jurisdictions).
      </p>
      <a
        href="https://x.com/djinn_gg"
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
      >
        Contact @djinn_gg on X
      </a>
    </div>
  );
}
