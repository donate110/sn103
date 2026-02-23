import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Education & Research | Djinn",
  description:
    "Research on Bittensor, dTAO, and decentralized AI economics. Education for sports betting and prediction markets.",
  openGraph: {
    title: "Djinn Protocol - Education & Research",
    description:
      "Research on Bittensor and dTAO. Education for sports betting and prediction markets.",
  },
};

interface Resource {
  title: string;
  source: string;
  url: string;
  description: string;
  tag: "interactive" | "paper" | "education";
  meta: string;
}

const RESOURCES: Resource[] = [
  {
    title: "TAO Valuation: Top-Down vs Bottom-Up",
    source: "Djinn Research",
    url: "/research/tao-valuation",
    description:
      "Interactive analysis examining Bittensor\u2019s network valuation through two lenses: market-based (top-down) versus sum-of-components (bottom-up). Tracks weekly snapshots from dTAO\u2019s launch in February 2025 through February 2026, with four interactive charts across 51 data points.",
    tag: "interactive",
    meta: "4 interactive charts \u00b7 51 weekly data points",
  },
  {
    title: "AMM-Implied Options on Bittensor Subnet Tokens",
    source: "Djinn Research",
    url: "/research/amm-options-paper.pdf",
    description:
      "Examines how the dTAO constant-product AMM mechanism generates implicit option-like payoffs for subnet stakers, establishing formal connections between liquidity provision mechanics and options valuation theory.",
    tag: "paper",
    meta: "Academic paper \u00b7 PDF",
  },
  {
    title: "Analytics.Bet",
    source: "Analytics.Bet",
    url: "https://analytics.bet/",
    description:
      "Education platform for sports betting and prediction markets. Home of the Master of Sports Betting program with courses from world-class experts and professional bettors. Also offering a live AI in Sports Betting & Prediction Markets course.",
    tag: "education",
    meta: "Courses \u00b7 Live & self-paced",
  },
];

const TAG_STYLES: Record<
  Resource["tag"],
  { bg: string; text: string; label: string }
> = {
  interactive: {
    bg: "bg-idiot-100",
    text: "text-idiot-700",
    label: "Interactive",
  },
  paper: { bg: "bg-slate-100", text: "text-slate-600", label: "Paper" },
  education: {
    bg: "bg-genius-100",
    text: "text-genius-700",
    label: "Education",
  },
};

export default function Education() {
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
          Education &amp; Research
        </h1>
        <p className="text-lg text-slate-500 max-w-2xl mx-auto">
          Research on Bittensor, dTAO, and decentralized AI economics.
          Education for sports betting and prediction markets.
        </p>
      </div>

      {/* Resource cards */}
      <section className="mb-16">
        <div className="grid gap-6">
          {RESOURCES.map((resource) => {
            const isExternal = resource.url.startsWith("http");
            const Wrapper = isExternal ? "a" : Link;
            const linkProps = isExternal
              ? { href: resource.url, target: "_blank" as const, rel: "noopener noreferrer" }
              : { href: resource.url };
            return (
            <Wrapper
              key={resource.url}
              {...linkProps}
              className="group card flex flex-col sm:flex-row sm:items-start gap-5 hover:shadow-lg transition-shadow"
            >
              {/* Icon */}
              <div
                className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${TAG_STYLES[resource.tag].bg}`}
              >
                {resource.tag === "interactive" && (
                  <svg
                    className={`w-6 h-6 ${TAG_STYLES[resource.tag].text}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
                    />
                  </svg>
                )}
                {resource.tag === "paper" && (
                  <svg
                    className={`w-6 h-6 ${TAG_STYLES[resource.tag].text}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                    />
                  </svg>
                )}
                {resource.tag === "education" && (
                  <svg
                    className={`w-6 h-6 ${TAG_STYLES[resource.tag].text}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.627 48.627 0 0112 20.904a48.627 48.627 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.57 50.57 0 00-2.658-.813A59.905 59.905 0 0112 3.493a59.902 59.902 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.697 50.697 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5"
                    />
                  </svg>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${TAG_STYLES[resource.tag].bg} ${TAG_STYLES[resource.tag].text}`}
                  >
                    {TAG_STYLES[resource.tag].label}
                  </span>
                  <span className="text-xs text-slate-400">
                    {resource.source}
                  </span>
                </div>
                <h3 className="font-semibold text-slate-900 mb-2 group-hover:text-idiot-600 transition-colors text-lg">
                  {resource.title}
                </h3>
                <p className="text-sm text-slate-500 leading-relaxed mb-2">
                  {resource.description}
                </p>
                <span className="text-xs text-slate-400">{resource.meta}</span>
              </div>

              {/* Arrow */}
              <svg
                className="w-5 h-5 text-slate-300 group-hover:text-idiot-500 shrink-0 transition-colors hidden sm:block mt-1"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                />
              </svg>
            </Wrapper>
            );
          })}
        </div>
      </section>
    </div>
  );
}
