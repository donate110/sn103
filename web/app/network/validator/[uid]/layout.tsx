import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Validator Details | Djinn Network",
  description: "Live status and miner scoring for a Djinn Protocol validator on Bittensor Subnet 103.",
};

export default function ValidatorDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
