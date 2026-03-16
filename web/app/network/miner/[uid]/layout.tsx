import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Miner Details | Djinn Network",
  description: "Live scoring breakdown for a Djinn Protocol miner on Bittensor Subnet 103.",
};

export default function MinerDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
