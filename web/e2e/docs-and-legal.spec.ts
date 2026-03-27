import { test, expect } from "@playwright/test";

test.describe("Docs landing page", () => {
  test("renders heading and 2x2 table", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "Documentation", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Choose your path" })).toBeVisible();
    // 2x2 table has Human and Computer rows
    await expect(page.locator("main").getByText("Human")).toBeVisible();
    await expect(page.locator("main").getByText("Computer")).toBeVisible();
  });

  test("has section cards linking to subpages", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "How Djinn Works" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "API Reference" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "SDK" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Smart Contracts" })).toBeVisible();
  });
});

test.describe("How It Works page", () => {
  test("renders 6-step walkthrough", async ({ page }) => {
    await page.goto("/docs/how-it-works");
    await expect(page.getByRole("heading", { name: "How Djinn Works" })).toBeVisible();
    await expect(page.getByText("Genius creates a signal")).toBeVisible();
    await expect(page.getByText("Idiot browses and purchases")).toBeVisible();
    await expect(page.getByText("The game happens")).toBeVisible();
    await expect(page.getByText("MPC settlement")).toBeVisible();
    await expect(page.getByText("USDC moves")).toBeVisible();
    await expect(page.getByText("Track record builds")).toBeVisible();
  });

  test("has key properties section", async ({ page }) => {
    await page.goto("/docs/how-it-works");
    await expect(page.getByText("Key properties")).toBeVisible();
    await expect(page.getByText("Signal secrecy")).toBeVisible();
    await expect(page.getByText("Verifiable track records")).toBeVisible();
    await expect(page.getByText("Non-custodial")).toBeVisible();
  });

  test("has CTAs for Genius and Idiot", async ({ page }) => {
    await page.goto("/docs/how-it-works");
    await expect(page.getByRole("link", { name: /Start as a Genius/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Start as an Idiot/i })).toBeVisible();
  });
});

test.describe("API Reference page", () => {
  test("renders all endpoint sections", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.getByRole("heading", { name: "API Reference", level: 1 })).toBeVisible();
    await expect(page.locator("main").getByText("Genius Endpoints")).toBeVisible();
    await expect(page.locator("main").getByText("Idiot Endpoints")).toBeVisible();
    await expect(page.locator("main").getByText("Public Endpoints")).toBeVisible();
  });

  test("shows authentication section", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.locator("main").getByRole("heading", { name: "Authentication" })).toBeVisible();
  });

  test("shows endpoint paths", async ({ page }) => {
    await page.goto("/docs/api");
    // Endpoint paths are in <code> tags
    await expect(page.locator("main code").filter({ hasText: "/api/genius/signal/commit" }).first()).toBeVisible();
    await expect(page.locator("main code").filter({ hasText: "/api/idiot/browse" }).first()).toBeVisible();
  });

  test("shows client-side encryption note", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.locator("main").getByRole("heading", { name: "Client-side encryption" })).toBeVisible();
  });
});

test.describe("SDK page", () => {
  test("renders SDK documentation", async ({ page }) => {
    await page.goto("/docs/sdk");
    await expect(page.getByRole("heading", { name: "Client SDK", level: 1 })).toBeVisible();
    await expect(page.locator("main strong").filter({ hasText: "Coming soon" })).toBeVisible();
    // Section headings
    await expect(page.locator("main").getByRole("heading", { name: /1\. Encryption/i })).toBeVisible();
    await expect(page.locator("main").getByRole("heading", { name: /2\. Decoy generation/i })).toBeVisible();
  });

  test("shows code example", async ({ page }) => {
    await page.goto("/docs/sdk");
    // Code block should have SDK import
    await expect(page.getByText("DjinnSDK")).toBeVisible();
    await expect(page.getByText("prepareSignal")).toBeVisible();
    await expect(page.getByText("encryptSignal")).toBeVisible();
  });

  test("shows security properties", async ({ page }) => {
    await page.goto("/docs/sdk");
    await expect(page.getByText("Plaintext never leaves client")).toBeVisible();
    await expect(page.getByText("Threshold decryption")).toBeVisible();
    await expect(page.getByText("Commitment binding")).toBeVisible();
  });
});

test.describe("Contracts page", () => {
  test("renders contract names", async ({ page }) => {
    await page.goto("/docs/contracts");
    await expect(page.getByRole("heading", { name: "Smart Contracts", level: 1 })).toBeVisible();
    const main = page.locator("main");
    await expect(main.getByText("SignalCommitment")).toBeVisible();
    await expect(main.getByText("OutcomeVoting")).toBeVisible();
    await expect(main.getByText("CreditLedger")).toBeVisible();
    await expect(main.getByText("KeyRecovery")).toBeVisible();
  });

  test("shows governance info", async ({ page }) => {
    await page.goto("/docs/contracts");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Governance" })).toBeVisible();
  });

  test("shows USDC section", async ({ page }) => {
    await page.goto("/docs/contracts");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "USDC" })).toBeVisible();
  });

  test("has BaseScan links", async ({ page }) => {
    await page.goto("/docs/contracts");
    const scanLinks = page.locator('main a[href*="basescan.org"]');
    expect(await scanLinks.count()).toBeGreaterThanOrEqual(4);
  });
});

test.describe("Blocked page", () => {
  test("renders restricted region message", async ({ page }) => {
    await page.goto("/blocked");
    await expect(page.getByText("Djinn is not available in your region")).toBeVisible();
    await expect(page.getByText("regulatory restrictions")).toBeVisible();
    await expect(page.getByRole("link", { name: /Terms of Service/i })).toBeVisible();
  });
});

test.describe("Updated Terms of Service", () => {
  test("has sanctions and prohibited conduct sections", async ({ page }) => {
    await page.goto("/terms");
    const main = page.locator("main");
    await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
    await expect(main.getByText("Restricted Jurisdictions")).toBeVisible();
    await expect(main.getByText("Financial Crime Prohibitions")).toBeVisible();
  });

  test("has arbitration and liability sections", async ({ page }) => {
    await page.goto("/terms");
    const main = page.locator("main");
    await expect(main.getByText("Indemnification")).toBeVisible();
    await expect(main.getByText("Limitation of Liability")).toBeVisible();
  });

  test("has API access section", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator("main").getByRole("heading", { name: "API Access" })).toBeVisible();
  });
});

test.describe("Updated Privacy Policy", () => {
  test("references MPC not ZK", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
    const mainText = await page.locator("main").textContent();
    expect(mainText).toContain("multi-party computation");
  });

  test("has geo-blocking and API disclosures", async ({ page }) => {
    await page.goto("/privacy");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: /Information We Process/i })).toBeVisible();
  });

  test("has international data transfer section", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("main").getByText("International Data Transfers")).toBeVisible();
  });
});

test.describe("Attestation product suite", () => {
  test("shows Debust, FirmRecord, ProveAudit links", async ({ page }) => {
    await page.goto("/attest");
    const main = page.locator("main");
    await expect(main.getByText("Web Attestation Suite")).toBeVisible();
    await expect(main.getByRole("link", { name: /Debust/i })).toBeVisible();
    await expect(main.getByRole("link", { name: /FirmRecord/i })).toBeVisible();
    await expect(main.getByRole("link", { name: /ProveAudit/i })).toBeVisible();
  });

  test("product descriptions explain constraints framing", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.locator("main").getByText("access constraints")).toBeVisible();
  });
});

test.describe("Homepage updates", () => {
  test("has navigation links", async ({ page }) => {
    await page.goto("/");
    // Main content area has text links
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: "Docs" })).toBeVisible();
    await expect(main.getByRole("link", { name: "About" })).toBeVisible();
  });

  test("no em dashes in visible text", async ({ page }) => {
    await page.goto("/");
    const bodyText = await page.locator("body").textContent();
    // Check for em dash (U+2014) and en dash (U+2013)
    expect(bodyText).not.toContain("\u2014");
    expect(bodyText).not.toContain("\u2013");
  });
});
