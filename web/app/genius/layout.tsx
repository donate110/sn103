import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Genius Dashboard | Djinn",
  description:
    "Manage your signals, collateral, and track record. Create encrypted predictions and build a verifiable track record on-chain.",
  openGraph: {
    title: "Genius Dashboard | Djinn",
    description:
      "Create encrypted predictions and build a cryptographically verifiable track record.",
  },
};

export default function GeniusLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
