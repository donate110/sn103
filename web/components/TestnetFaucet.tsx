"use client";

import { useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { ethers } from "ethers";
import { ADDRESSES } from "@/lib/contracts";

const MINT_ABI = ["function mint(address to, uint256 amount) external"];
const MINT_AMOUNT = 10_000n * 1_000_000n; // 10,000 USDC (6 decimals)

export default function TestnetFaucet() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  if (!address || !walletClient) return null;

  const handleMint = async () => {
    setLoading(true);
    setDone(false);
    try {
      const provider = new ethers.BrowserProvider(walletClient.transport, "any");
      const signer = await provider.getSigner();
      const usdc = new ethers.Contract(ADDRESSES.usdc, MINT_ABI, signer);
      const tx = await usdc.mint(address, MINT_AMOUNT);
      await tx.wait();
      setDone(true);
      setTimeout(() => setDone(false), 4000);
    } catch (err) {
      console.error("[faucet] mint failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleMint}
      disabled={loading}
      className="underline hover:no-underline font-semibold disabled:opacity-50"
    >
      {loading ? "Minting..." : done ? "10,000 USDC added!" : "Get free test USDC"}
    </button>
  );
}
