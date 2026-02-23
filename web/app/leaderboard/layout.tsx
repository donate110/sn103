import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leaderboard | Djinn",
  description:
    "See top-performing Geniuses ranked by on-chain verified track records. Quality scores, win rates, and ROI on the Djinn sports intelligence marketplace.",
  openGraph: {
    title: "Djinn Leaderboard",
    description:
      "Top analysts ranked by on-chain verified track records on the Djinn sports intelligence marketplace.",
  },
};

export default function LeaderboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
