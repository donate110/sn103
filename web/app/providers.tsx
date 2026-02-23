"use client";

import { useEffect } from "react";
import { WagmiProvider, createConfig, http, useConnect } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, getDefaultConfig } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  metaMaskWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { mock } from "wagmi/connectors";
import "@rainbow-me/rainbowkit/styles.css";

const IS_E2E = process.env.NEXT_PUBLIC_E2E_TEST === "true";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org";
const activeChain = CHAIN_ID === 8453 ? base : baseSepolia;

// Anvil account #0 — used only in E2E test builds
const TEST_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

coinbaseWallet.preference = "smartWalletOnly";

const prodConfig = getDefaultConfig({
  appName: "Djinn",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "djinn-dev",
  chains: [activeChain],
  transports: {
    [activeChain.id]: http(RPC_URL),
  },
  multiInjectedProviderDiscovery: true,
  wallets: [
    {
      groupName: "Create a Wallet (Free)",
      wallets: [coinbaseWallet],
    },
    {
      groupName: "I already have a wallet",
      wallets: [metaMaskWallet, walletConnectWallet],
    },
  ],
});

// E2E tests always use Base Sepolia
const e2eConfig = IS_E2E
  ? createConfig({
      chains: [baseSepolia],
      connectors: [
        mock({
          accounts: [TEST_ACCOUNT],
          features: { defaultConnected: true, reconnect: true },
        }),
      ],
      transports: {
        [baseSepolia.id]: http(RPC_URL),
      },
    })
  : null;

export const wagmiConfig = e2eConfig ?? prodConfig;

const queryClient = new QueryClient();

/** Auto-connect the mock wallet on mount in E2E mode. */
function E2EAutoConnect({ children }: { children: React.ReactNode }) {
  const { connect, connectors } = useConnect();
  useEffect(() => {
    const mockConnector = connectors.find((c) => c.id === "mock");
    if (mockConnector) {
      connect({ connector: mockConnector });
    }
  }, [connect, connectors]);
  return <>{children}</>;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  if (IS_E2E) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <E2EAutoConnect>
            {children}
          </E2EAutoConnect>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          initialChain={activeChain}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
