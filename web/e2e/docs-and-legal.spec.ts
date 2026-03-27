import { test, expect } from "@playwright/test";

test.describe("Docs landing page", () => {
  test("renders heading and 2x2 table", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
    await expect(page.getByText("Choose your path")).toBeVisible();
    // 2x2 table cells
    await expect(page.getByText("Human")).toBeVisible();
    await expect(page.getByText("Computer")).toBeVisible();
    await expect(page.getByText("Genius")).first().toBeVisible();
    await expect(page.getByText("Idiot")).first().toBeVisible();
  });

  test("has section cards linking to subpages", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.getByRole("link", { name: /How Djinn Works/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /API Reference/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /SDK/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Smart Contracts/i })).toBeVisible();
  });

  test("2x2 table links work", async ({ page }) => {
    await page.goto("/docs");
    // Human Genius links to /genius
    const geniusCell = page.getByRole("link", { name: /Web App.*Create signals/i }).first();
    await expect(geniusCell).toHaveAttribute("href", "/genius");
    // Computer cells link to /docs/api
    const apiCell = page.getByRole("link", { name: /API \+ SDK.*Automate/i }).first();
    await expect(apiCell).toHaveAttribute("href", "/docs/api");
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
    await expect(page.getByRole("heading", { name: "API Reference" })).toBeVisible();
    await expect(page.getByText("Genius Endpoints")).toBeVisible();
    await expect(page.getByText("Idiot Endpoints")).toBeVisible();
    await expect(page.getByText("Public Endpoints")).toBeVisible();
  });

  test("shows authentication section", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.getByText("Authentication")).toBeVisible();
    await expect(page.getByText("POST /api/auth/connect")).toBeVisible();
  });

  test("shows endpoint details with methods", async ({ page }) => {
    await page.goto("/docs/api");
    // Check for method badges
    await expect(page.getByText("GET").first()).toBeVisible();
    await expect(page.getByText("POST").first()).toBeVisible();
    // Check for specific endpoints
    await expect(page.getByText("/api/genius/signal/prepare")).toBeVisible();
    await expect(page.getByText("/api/idiot/browse")).toBeVisible();
    await expect(page.getByText("/api/odds")).toBeVisible();
  });

  test("shows client-side encryption note", async ({ page }) => {
    await page.goto("/docs/api");
    await expect(page.getByText("Client-side encryption")).toBeVisible();
    await expect(page.getByText("plaintext picks")).toBeVisible();
  });
});

test.describe("SDK page", () => {
  test("renders SDK documentation", async ({ page }) => {
    await page.goto("/docs/sdk");
    await expect(page.getByRole("heading", { name: "Client SDK" })).toBeVisible();
    await expect(page.getByText("Coming soon")).toBeVisible();
    await expect(page.getByText("Encryption")).toBeVisible();
    await expect(page.getByText("Decoy generation")).toBeVisible();
    await expect(page.getByText("Shamir splitting")).toBeVisible();
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
  test("renders all 8 contracts", async ({ page }) => {
    await page.goto("/docs/contracts");
    await expect(page.getByRole("heading", { name: "Smart Contracts" })).toBeVisible();
    await expect(page.getByText("SignalCommitment")).toBeVisible();
    await expect(page.getByText("Escrow")).first().toBeVisible();
    await expect(page.getByText("Collateral")).first().toBeVisible();
    await expect(page.getByText("Account")).first().toBeVisible();
    await expect(page.getByText("Audit")).first().toBeVisible();
    await expect(page.getByText("OutcomeVoting")).toBeVisible();
    await expect(page.getByText("CreditLedger")).toBeVisible();
    await expect(page.getByText("KeyRecovery")).toBeVisible();
  });

  test("shows governance info", async ({ page }) => {
    await page.goto("/docs/contracts");
    await expect(page.getByText("Governance")).toBeVisible();
    await expect(page.getByText("TimelockController")).toBeVisible();
    await expect(page.getByText("72-hour")).toBeVisible();
  });

  test("shows USDC addresses", async ({ page }) => {
    await page.goto("/docs/contracts");
    await expect(page.getByText("MockUSDC")).toBeVisible();
    await expect(page.getByText("Circle USDC")).toBeVisible();
  });

  test("contract addresses link to BaseScan", async ({ page }) => {
    await page.goto("/docs/contracts");
    const scanLinks = page.locator('a[href*="basescan.org"]');
    expect(await scanLinks.count()).toBeGreaterThanOrEqual(8);
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
    await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
    await expect(page.getByText("Restricted Jurisdictions")).toBeVisible();
    await expect(page.getByText("Financial Crime Prohibitions")).toBeVisible();
    await expect(page.getByText("Launder money")).toBeVisible();
    await expect(page.getByText("Insider trading")).toBeVisible();
    await expect(page.getByText("Arbitration")).toBeVisible();
  });

  test("has indemnification and limitation of liability", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByText("Indemnification")).toBeVisible();
    await expect(page.getByText("Limitation of Liability")).toBeVisible();
    await expect(page.getByText("Class action waiver")).toBeVisible();
  });

  test("has API access section", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByText("API Access")).toBeVisible();
  });
});

test.describe("Updated Privacy Policy", () => {
  test("references MPC not ZK", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).toContain("multi-party computation");
    expect(bodyText).not.toContain("zero-knowledge");
    expect(bodyText).not.toContain("ZK proof");
  });

  test("has geo-blocking and API disclosures", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByText("Information We Process")).toBeVisible();
    await expect(page.getByText("IP addresses")).first().toBeVisible();
    await expect(page.getByText("API request metadata")).toBeVisible();
  });

  test("has international data transfer section", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByText("International Data Transfers")).toBeVisible();
  });
});

test.describe("Attestation product suite", () => {
  test("shows Debust, FirmRecord, ProveAudit links", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.getByText("Web Attestation Suite")).toBeVisible();
    await expect(page.getByRole("link", { name: /Debust/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /FirmRecord/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /ProveAudit/i })).toBeVisible();
  });

  test("product descriptions explain constraints framing", async ({ page }) => {
    await page.goto("/attest");
    await expect(page.getByText("access constraints")).toBeVisible();
    await expect(page.getByText("Experimental")).first().toBeVisible();
  });
});

test.describe("Homepage updates", () => {
  test("has Docs and Network links in quick nav", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Docs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Network" })).toBeVisible();
  });

  test("no em dashes in visible text", async ({ page }) => {
    await page.goto("/");
    const bodyText = await page.locator("body").textContent();
    // Check for em dash (U+2014) and en dash (U+2013)
    expect(bodyText).not.toContain("\u2014");
    expect(bodyText).not.toContain("\u2013");
  });
});
