import { test as base, expect, type Page } from "@playwright/test";
import { installMockWallet } from "@johanneskares/wallet-mock";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  MOCK_ODDS_EVENTS,
  MOCK_NFL_EVENTS,
  ZERO_ENCODED,
  USDC_1000_ENCODED,
} from "./mock-data";

// Anvil default private key (account #0) for deterministic wallet in tests
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;

/**
 * Set up common page interceptors for authenticated E2E tests.
 * - Mocks /api/odds to return deterministic events
 * - Mocks RPC calls for balance reads (so pages render without chain access)
 */
export async function setupAuthenticatedPage(page: Page) {
  // Mock the odds API
  await page.route("**/api/odds**", async (route) => {
    const url = new URL(route.request().url());
    const sport = url.searchParams.get("sport") ?? "";

    let data = MOCK_ODDS_EVENTS;
    if (sport.includes("nfl") || sport.includes("football")) {
      data = MOCK_NFL_EVENTS;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });

  // Mock subgraph calls (protocol stats)
  await page.route("**/subgraphs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          protocolStats: {
            totalVolume: "50000000000",
            totalSignals: "42",
            totalPurchases: "156",
          },
        },
      }),
    });
  });

  // Mock RPC eth_call responses (balances, allowances) so pages render
  // without a real chain connection
  await page.route("**/sepolia.base.org**", async (route) => {
    let body: { method?: string; id?: number } | null = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      // GET requests or non-JSON bodies
    }
    if (!body) {
      await route.continue();
      return;
    }
    const method = body.method;
    if (method === "eth_call") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: USDC_1000_ENCODED }),
      });
    } else if (method === "eth_chainId") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x14a34" }),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Extended test fixture with authenticated page and wallet mock.
 * wallet-mock auto-connects via EIP-6963 (no click-through needed).
 */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await installMockWallet({
      page,
      account: privateKeyToAccount(TEST_PRIVATE_KEY),
      defaultChain: baseSepolia,
    });
    await setupAuthenticatedPage(page);
    await use(page);
  },
});

export { expect };
