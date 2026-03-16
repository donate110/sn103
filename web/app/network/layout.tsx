import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Network | Djinn",
  description:
    "Live status of Djinn Protocol validators and miners on Bittensor Subnet 103. Check node health, scoring, and network statistics.",
};

export default function NetworkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
