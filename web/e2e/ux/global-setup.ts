import {
  getGeniusWallet,
  getIdiotWallet,
  ensureFunded,
  getWalletSummary,
} from "./helpers/wallet-pool";

/**
 * Global setup: fund all test wallets before any journey runs.
 *
 * This runs once before the entire test suite. It checks balances
 * and tops up wallets that are low on ETH or USDC.
 */
const IDIOT_POOL_SIZE = 3;

export default async function globalSetup() {
  console.log("\n=== UX Suite: Pre-flight wallet funding ===\n");

  const deployerKey = process.env.E2E_DEPLOYER_KEY;
  if (!deployerKey || deployerKey.length !== 66) {
    console.log("WARNING: E2E_DEPLOYER_KEY not set. Skipping wallet funding.");
    console.log(
      "Tests requiring on-chain transactions will be skipped.\n",
    );
    return;
  }

  const geniusKey = process.env.E2E_GENIUS_KEY;
  if (!geniusKey || geniusKey.length !== 66) {
    console.log("WARNING: E2E_GENIUS_KEY not set. Genius tests will be skipped.\n");
  }

  // Fund genius wallet
  if (geniusKey && geniusKey.length === 66) {
    try {
      const genius = getGeniusWallet();
      const result = await ensureFunded(genius);
      console.log(
        `Genius ${genius.address}: ${result.ethBefore} ETH, ${result.usdcBefore} USDC${result.funded ? " (topped up)" : " (OK)"}`,
      );
    } catch (e) {
      console.log(`Failed to fund genius: ${e}`);
    }
  }

  // Fund idiot pool
  for (let i = 0; i < IDIOT_POOL_SIZE; i++) {
    try {
      const idiot = getIdiotWallet(i);
      const result = await ensureFunded(idiot);
      console.log(
        `Idiot[${i}] ${idiot.address}: ${result.ethBefore} ETH, ${result.usdcBefore} USDC${result.funded ? " (topped up)" : " (OK)"}`,
      );
    } catch (e) {
      console.log(`Failed to fund idiot[${i}]: ${e}`);
    }
  }

  console.log("\n" + (await getWalletSummary(IDIOT_POOL_SIZE)));
  console.log("\n=== Wallet funding complete ===\n");
}
