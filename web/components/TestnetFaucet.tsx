"use client";

import { useState } from "react";
import { useAccount, useChainId, useWalletClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { base, baseSepolia } from "wagmi/chains";
import { ADDRESSES } from "@/lib/contracts";

const MINT_AMOUNT = 10_000n * 1_000_000n; // 10,000 USDC (6 decimals)
const EXPECTED_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532");
const expectedChain = EXPECTED_CHAIN_ID === 8453 ? base : baseSepolia;

export default function TestnetFaucet() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { data: walletClient } = useWalletClient();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  if (!address || !walletClient) return null;

  const handleMint = async () => {
    if (chainId !== EXPECTED_CHAIN_ID) {
      setError(`Switch to ${expectedChain.name}`);
      setTimeout(() => setError(""), 5000);
      return;
    }
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
        chain: expectedChain,
        account: address,
        to: ADDRESSES.usdc as `0x${string}`,
        data,
      });
      setDone(true);
      setTimeout(() => setDone(false), 6000);
    } catch (err: any) {
      console.error("[faucet] mint failed:", err);
      const msg = err?.shortMessage || err?.message || "Mint failed";
      if (/insufficient funds for gas/i.test(msg)) {
        setError("Need ETH for gas fees");
      } else if (/user rejected|user denied|ACTION_REJECTED/i.test(msg)) {
        setError("Transaction cancelled");
      } else {
        setError(err?.shortMessage || "Mint failed");
      }
      setTimeout(() => setError(""), 5000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <span>
      <button
        onClick={handleMint}
        disabled={loading}
        className="underline hover:no-underline font-semibold disabled:opacity-50"
      >
        {loading ? "Minting..." : done ? "10,000 USDC added!" : error ? error : "Get free test USDC"}
      </button>
      {error && /ETH for gas/i.test(error) && (
        <>{" "}<a href="https://faucet.quicknode.com/base/sepolia" target="_blank" rel="noopener noreferrer" className="underline text-blue-600">Get free testnet ETH</a></>
      )}
    </span>
  );
}
