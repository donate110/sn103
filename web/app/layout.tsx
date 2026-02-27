import type { Metadata, Viewport } from "next";
import { Inter, Cinzel } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import Providers from "./providers";
import Layout from "@/components/Layout";
import BetaGate from "@/components/BetaGate";
import ServiceWorker from "@/components/ServiceWorker";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
const cinzel = Cinzel({
  subsets: ["latin"],
  variable: "--font-wordmark",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Djinn | Sports Intelligence Marketplace",
  description:
    "Analysts sell encrypted predictions. Buyers purchase access. Signals stay secret forever. Track records are cryptographically verifiable. Built on Bittensor Subnet 103, settled in USDC on Base.",
  manifest: "/manifest.json",
  themeColor: "#0f172a",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Djinn | Sports Intelligence Marketplace",
    description:
      "Unbundling information from execution. Encrypted predictions, verifiable track records, settled in USDC on Base.",
    siteName: "Djinn",
    images: [
      {
        url: "https://djinn.gg/icon-512.png",
        width: 512,
        height: 512,
        alt: "Djinn Protocol",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Djinn | Sports Intelligence Marketplace",
    description:
      "Unbundling information from execution. Encrypted predictions, verifiable track records, settled in USDC on Base.",
    images: ["https://djinn.gg/icon-512.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} ${cinzel.variable}`}>
        <Analytics />
        <ServiceWorker />
        <BetaGate>
          <Providers>
            <Layout>{children}</Layout>
          </Providers>
        </BetaGate>
      </body>
    </html>
  );
}
