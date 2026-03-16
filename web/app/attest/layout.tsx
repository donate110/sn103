import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Web Attestation | Djinn",
  description:
    "Generate cryptographic TLSNotary proofs that websites served specific content at a specific time. Free and powered by Bittensor Subnet 103.",
};

export default function AttestLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
