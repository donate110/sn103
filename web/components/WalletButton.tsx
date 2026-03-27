"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import TermsModal, { useTermsAccepted } from "./TermsModal";

const IS_E2E = process.env.NEXT_PUBLIC_E2E_TEST === "true";

function E2EWalletButton() {
  const { address, isConnected } = useAccount();
  if (!isConnected) return null;
  return (
    <span
      data-testid="wallet-address"
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700"
    >
      {address?.slice(0, 6)}...{address?.slice(-4)}
    </span>
  );
}

export default function WalletButton() {
  if (IS_E2E) return <E2EWalletButton />;
  return <WalletButtonInner />;
}

function WalletButtonInner() {
  const { accepted, accept } = useTermsAccepted();
  const [showTerms, setShowTerms] = useState(false);
  // Store the openConnectModal callback so we can call it after ToS acceptance
  const [pendingConnect, setPendingConnect] = useState<(() => void) | null>(null);

  function handleConnectClick(openConnectModal: () => void) {
    if (accepted) {
      openConnectModal();
    } else {
      setPendingConnect(() => openConnectModal);
      setShowTerms(true);
    }
  }

  function handleAccept() {
    accept();
    setShowTerms(false);
    // Open the wallet connect modal after accepting
    if (pendingConnect) {
      pendingConnect();
      setPendingConnect(null);
    }
  }

  function handleDecline() {
    setShowTerms(false);
    setPendingConnect(null);
  }

  return (
    <>
      <TermsModal
        open={showTerms}
        onAccept={handleAccept}
        onDecline={handleDecline}
      />
      <ConnectButton.Custom>
        {({
          account,
          chain,
          openConnectModal,
          openAccountModal,
          openChainModal,
          mounted,
        }) => {
          const ready = mounted;
          const connected = ready && account && chain;

          if (!ready) return null;

          if (!connected) {
            return (
              <button
                onClick={() => handleConnectClick(openConnectModal)}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 transition-colors"
              >
                Get Started
              </button>
            );
          }

          if (chain?.unsupported) {
            return (
              <button
                onClick={openChainModal}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white"
              >
                Wrong Network
              </button>
            );
          }

          return (
            <button
              onClick={openAccountModal}
              data-testid="wallet-address"
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              {account.displayName}
            </button>
          );
        }}
      </ConnectButton.Custom>
    </>
  );
}
