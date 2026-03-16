/**
 * Testnet-only wallet connector for QA testing.
 *
 * Reads a private key from sessionStorage ("djinn_test_key") and creates
 * a real signer. Only works on Base Sepolia (chainId 84532). The key is
 * never persisted beyond the browser session.
 *
 * Usage: set sessionStorage.setItem("djinn_test_key", "0x...") then reload.
 */
import { createConnector } from "@wagmi/core";
import {
  createWalletClient,
  http,
  type EIP1193RequestFn,
  custom,
  type Hash,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://sepolia.base.org";

export function getTestKey(): `0x${string}` | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem("djinn_test_key");
  if (!raw || !raw.startsWith("0x") || raw.length !== 66) return null;
  return raw as `0x${string}`;
}

export function testWalletConnector() {
  let account: PrivateKeyAccount | null = null;

  return createConnector((config) => ({
    id: "testWallet",
    name: "Test Wallet",
    type: "testWallet" as const,

    async setup() {
      const key = getTestKey();
      if (key) {
        account = privateKeyToAccount(key);
      }
    },

    connect: (async () => {
      const key = getTestKey();
      if (!key) throw new Error("No test key in sessionStorage");
      account = privateKeyToAccount(key);
      return {
        accounts: [account.address] as readonly `0x${string}`[],
        chainId: baseSepolia.id as number,
      };
    }) as never,

    async disconnect() {
      account = null;
    },

    async getAccounts() {
      if (!account) return [];
      return [account.address];
    },

    async getChainId() {
      return baseSepolia.id;
    },

    async getProvider(): Promise<{ request: EIP1193RequestFn }> {
      const key = getTestKey();
      if (!key) throw new Error("No test key");
      const acct = privateKeyToAccount(key);

      const walletClient = createWalletClient({
        account: acct,
        chain: baseSepolia,
        transport: http(RPC_URL),
      });

      // Wrap the wallet client as an EIP-1193 provider
      const provider = {
        request: (async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [acct.address];

            case "eth_chainId":
              return `0x${baseSepolia.id.toString(16)}`;

            case "wallet_switchEthereumChain":
              return null;

            case "personal_sign": {
              const [message] = params as [Hash, string];
              const sig = await acct.signMessage({
                message: { raw: message },
              });
              return sig;
            }

            case "eth_signTypedData_v4": {
              const [, typedDataStr] = params as [string, string];
              const typedData = JSON.parse(typedDataStr);
              const sig = await acct.signTypedData({
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message,
              });
              return sig;
            }

            case "eth_sendTransaction": {
              const [tx] = params as [Record<string, string>];
              const hash = await walletClient.sendTransaction({
                to: tx.to as `0x${string}`,
                data: (tx.data as `0x${string}`) || undefined,
                value: tx.value ? BigInt(tx.value) : 0n,
                gas: tx.gas ? BigInt(tx.gas) : undefined,
              });
              return hash;
            }

            case "eth_estimateGas": {
              // Proxy to RPC
              const response = await fetch(RPC_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  params,
                }),
              });
              const json = await response.json();
              if (json.error) throw new Error(json.error.message);
              return json.result;
            }

            default: {
              // Proxy everything else to the RPC
              const response = await fetch(RPC_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  params,
                }),
              });
              const json = await response.json();
              if (json.error) throw new Error(json.error.message);
              return json.result;
            }
          }
        }) as EIP1193RequestFn,

        on: () => {},
        removeListener: () => {},
      };

      return provider;
    },

    async isAuthorized() {
      return !!getTestKey();
    },

    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }));
}
