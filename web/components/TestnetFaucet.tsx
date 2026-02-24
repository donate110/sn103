"use client";

import { useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { ADDRESSES } from "@/lib/contracts";

const MINT_AMOUNT = 10_000n * 1_000_000n; // 10,000 USDC (6 decimals)

export default function TestnetFaucet() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!address || !walletClient) return null;

  const handleMint = async () => {
    setLoading(true);
    setDone(false);
    setError("");
    try {
      const data = encodeFunctionData({
        abi: [{ name: "mint", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }],
        functionName: "mint",
        args: [address, MINT_AMOUNT],
      });
      const hash = await walletClient.sendTransaction({
        to: ADDRESSES.usdc as `0x${string}`,
        data,
      });
      setDone(true);
      setTimeout(() => setDone(false), 6000);
    } catch (err: any) {
      console.error("[faucet] mint failed:", err);
      setError(err?.shortMessage || "Mint failed");
      setTimeout(() => setError(""), 5000);
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
      {loading ? "Minting..." : done ? "10,000 USDC added!" : error ? error : "Get free test USDC"}
    </button>
  );
}
