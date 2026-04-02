import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

/**
 * Wallet pool for UX testing.
 *
 * Uses:
 * - E2E_DEPLOYER_KEY: Mints USDC and funds test wallets with ETH
 * - E2E_GENIUS_KEY: Fixed genius wallet
 * - Deterministic derivation: keccak256(seed + index) for idiot wallet pool
 */

const RPC_URL = "https://sepolia.base.org";
const transport = http(RPC_URL);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport,
});

// Seed for deterministic idiot wallet derivation
const DEFAULT_SEED = "djinn-ux-test-2026";

const USDC_ADDRESS =
  (process.env.NEXT_PUBLIC_USDC_ADDRESS as `0x${string}`) ||
  "0x00e8293b05dbD3732EF3396ad1483E87e7265054";

const USDC_MINT_ABI = [
  {
    name: "mint",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface WalletInfo {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  role: "genius" | "idiot";
  index: number;
}

/** Get the genius wallet from env. */
export function getGeniusWallet(): WalletInfo {
  const key = (process.env.E2E_GENIUS_KEY || "") as `0x${string}`;
  if (!key || key.length !== 66) {
    throw new Error("E2E_GENIUS_KEY not set or invalid");
  }
  const account = privateKeyToAccount(key);
  return {
    privateKey: key,
    address: account.address,
    role: "genius",
    index: 0,
  };
}

/**
 * Derive a deterministic idiot wallet from a seed + index.
 * Uses keccak256 for derivation (no external BIP dependencies needed).
 * Each index gives a unique, reproducible wallet.
 */
export function getIdiotWallet(index: number): WalletInfo {
  const seed = process.env.UX_WALLET_SEED || DEFAULT_SEED;
  const privateKey = keccak256(
    toBytes(`${seed}-idiot-${index}`),
  ) as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  return {
    privateKey,
    address: account.address,
    role: "idiot",
    index,
  };
}

/** Check ETH balance. */
export async function getEthBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.getBalance({ address });
}

/** Check USDC balance. */
export async function getUsdcBalance(address: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}

/** Send ETH from deployer to a target address. */
export async function fundEth(
  toAddress: `0x${string}`,
  amountEth = "0.00005", // ~50 Base Sepolia txns worth of gas
): Promise<void> {
  const deployerKey = (process.env.E2E_DEPLOYER_KEY || "") as `0x${string}`;
  if (!deployerKey || deployerKey.length !== 66) {
    throw new Error("E2E_DEPLOYER_KEY not set");
  }
  const deployer = privateKeyToAccount(deployerKey);
  const walletClient = createWalletClient({
    account: deployer,
    chain: baseSepolia,
    transport,
  });
  const hash = await walletClient.sendTransaction({
    to: toAddress,
    value: parseUnits(amountEth, 18),
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Mint USDC from deployer to a target address. */
export async function mintUsdc(
  toAddress: `0x${string}`,
  amountUsdc = "5000",
): Promise<void> {
  const deployerKey = (process.env.E2E_DEPLOYER_KEY || "") as `0x${string}`;
  if (!deployerKey || deployerKey.length !== 66) {
    throw new Error("E2E_DEPLOYER_KEY not set");
  }
  const deployer = privateKeyToAccount(deployerKey);
  const walletClient = createWalletClient({
    account: deployer,
    chain: baseSepolia,
    transport,
  });
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_MINT_ABI,
    functionName: "mint",
    args: [toAddress, parseUnits(amountUsdc, 6)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Minimum ETH balance required (gas for ~10 transactions on Base Sepolia). */
const MIN_ETH = parseUnits("0.00003", 18);
/** Minimum USDC balance required for testing. */
const MIN_USDC = parseUnits("100", 6);

/**
 * Ensure a wallet has enough ETH and USDC for testing.
 * Funds from deployer if below minimums.
 */
export async function ensureFunded(wallet: WalletInfo): Promise<{
  ethBefore: string;
  usdcBefore: string;
  funded: boolean;
}> {
  const ethBalance = await getEthBalance(wallet.address);
  const usdcBalance = await getUsdcBalance(wallet.address);

  let funded = false;

  if (ethBalance < MIN_ETH) {
    console.log(`  Funding ${wallet.role}[${wallet.index}] with ETH...`);
    await fundEth(wallet.address);
    funded = true;
  }

  if (usdcBalance < MIN_USDC) {
    console.log(`  Minting USDC for ${wallet.role}[${wallet.index}]...`);
    await mintUsdc(wallet.address);
    funded = true;
  }

  return {
    ethBefore: formatUnits(ethBalance, 18),
    usdcBefore: formatUnits(usdcBalance, 6),
    funded,
  };
}

/** Get a summary of all test wallets and their balances. */
export async function getWalletSummary(idiotCount = 3): Promise<string> {
  const lines: string[] = ["=== UX Test Wallet Summary ==="];

  try {
    const genius = getGeniusWallet();
    const ethBal = formatUnits(await getEthBalance(genius.address), 18);
    const usdcBal = formatUnits(await getUsdcBalance(genius.address), 6);
    lines.push(`Genius: ${genius.address} | ${ethBal} ETH | ${usdcBal} USDC`);
  } catch (e) {
    lines.push(`Genius: NOT CONFIGURED (${e})`);
  }

  for (let i = 0; i < idiotCount; i++) {
    try {
      const idiot = getIdiotWallet(i);
      const ethBal = formatUnits(await getEthBalance(idiot.address), 18);
      const usdcBal = formatUnits(await getUsdcBalance(idiot.address), 6);
      lines.push(
        `Idiot[${i}]: ${idiot.address} | ${ethBal} ETH | ${usdcBal} USDC`,
      );
    } catch (e) {
      lines.push(`Idiot[${i}]: ERROR (${e})`);
    }
  }

  return lines.join("\n");
}
