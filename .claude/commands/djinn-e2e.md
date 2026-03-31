# Djinn E2E User Testing

Run comprehensive end-to-end user testing against the live Djinn site (djinn.gg). Test every user-facing flow, screenshot each page, and report every issue found.

## Setup

Use Playwright MCP tools (browser_navigate, browser_snapshot, browser_take_screenshot, etc.) to drive a real browser. Base URL: `https://djinn.gg`

Screenshots go in `~/djinn/screenshots-tmp/` (create if needed). Name them descriptively: `{flow}-{step}.png`.

## Test Flows (run in order)

### 1. Homepage & Navigation
- Navigate to `/` and verify branding loads ("DJINN", "The Genius-Idiot Network")
- Screenshot the full homepage
- Click each nav link (Genius, Idiot, Leaderboard, Network, Attest, Docs, About) and verify each page loads with correct heading
- Test mobile viewport (375x667): verify no horizontal overflow on homepage, genius, idiot pages

### 2. Documentation & Legal Pages
- Navigate to `/docs` and verify content loads
- Check sub-pages: `/docs/how-it-works`, `/docs/api`, `/docs/contracts`, `/docs/sdk`
- Check `/terms`, `/privacy`, `/about`, `/education`
- Screenshot any page that shows errors or blank content

### 3. Network Status
- Navigate to `/network`
- Verify it shows validator/miner data (table or cards)
- Click into a validator detail page (e.g., `/network/validator/2`)
- Click into a miner detail page if available
- Screenshot the network page
- Note: data may take 5-10s to load from metagraph

### 4. Leaderboard
- Navigate to `/leaderboard`
- Verify the table/list renders
- Check if any genius addresses appear
- Screenshot the page

### 5. Browse Signals (Idiot perspective, no wallet)
- Navigate to `/idiot/browse`
- Wait up to 15s for signals to load
- Verify signal cards appear (or "no signals" message)
- Screenshot the browse page
- If signals exist, click into one and verify the signal detail page loads
- Screenshot the signal detail page

### 6. Genius Dashboard (no wallet)
- Navigate to `/genius`
- Verify "Connect your wallet" prompt appears
- Screenshot

### 7. Idiot Dashboard (no wallet)
- Navigate to `/idiot`
- Verify "Connect your wallet" prompt appears
- Screenshot

### 8. Signal Creation Page (no wallet)
- Navigate to `/genius/signal/new`
- Verify the page loads (should show connect prompt or step 1)
- Screenshot

### 9. Attestation Page
- Navigate to `/attest`
- Verify the page loads with attestation UI
- Screenshot

### 10. API Health Checks
Use browser fetch or direct HTTP to test:
- `GET /api/health` - should return `{"status":"ok"}`
- `GET /api/odds?sport=basketball_nba` - should return data or empty array (not 500)
- `GET /api/validators/discover` - should return validator list
- `GET /api/network/status` - should return network data
- `GET /api/idiot/browse` - should return signal list

### 11. Error Handling
- Navigate to `/nonexistent-page` - verify 404 page renders
- Navigate to `/idiot/signal/999999` - verify graceful error (not crash)

### 12. Mobile Responsiveness
- Set viewport to 375x667 (iPhone SE)
- Navigate to `/`, `/genius`, `/idiot`, `/leaderboard`, `/idiot/browse`
- Verify no horizontal scrollbar on any page
- Check that navigation is accessible (hamburger menu or similar)
- Screenshot mobile homepage

## Reporting

After all tests, produce a report:

```
## Djinn E2E Test Report - {date}

### Summary
- Pages tested: X
- Issues found: X (Y critical, Z minor)
- Screenshots: saved to screenshots-tmp/

### Critical Issues (blocks launch)
- [issue description + screenshot reference]

### Minor Issues
- [issue description]

### All Pages Status
| Page | Status | Notes |
|------|--------|-------|
| /    | OK/FAIL | ... |
| ...  | ...    | ... |

### API Endpoints
| Endpoint | Status | Response |
|----------|--------|----------|
| /api/health | OK/FAIL | ... |
| ...      | ...    | ... |
```

Save the report to `~/djinn/test-results/e2e-report-{date}.md`.

After the report, log results to `./work-results.tsv` if running under /work.

## Arguments

If arguments are provided, run only the specified flow number(s). Example: `/djinn-e2e 5 10` runs only Browse Signals and API Health Checks.
