# Djinn E2E User Testing

Comprehensive end-to-end testing of the Djinn Protocol web app. Tests every user flow, measures latency at each step, probes infrastructure health, and produces an actionable report.

## Important: Vercel Bot Protection

Vercel Attack Challenge Mode blocks automated browsers after ~6 rapid full-page navigations from the same IP. Mitigations:

1. **Prefer local server**: Run `cd ~/djinn/web && npm run build && PORT=3099 npx next start -p 3099` and test against `http://localhost:3099`. This avoids bot protection entirely and tests the same code.
2. **If testing production**: Space navigations 3+ seconds apart. Use `browser_evaluate` with setTimeout for delays between pages. If you hit "Vercel Security Checkpoint", close browser, wait 30s, reopen.
3. **Client-side navigation is safe**: Next.js Link transitions don't trigger challenges. Only `browser_navigate` (full page load) triggers it.
4. **API calls via curl**: Vercel bot protection also blocks rapid API calls from the same IP. Use curl for API timing tests since it has a different fingerprint.

## Phase 1: Infrastructure Health (do this first, no browser needed)

Run the timing test script for real on-chain + API measurements:

```bash
cd ~/djinn/web
source .env
export E2E_TEST_PRIVATE_KEY="$E2E_TEST_PRIVATE_KEY"
node scripts/ux-timing-test.mjs --signals 5 --purchases 5
```

This creates real signals on Base Sepolia, attempts purchases, probes validators, and measures API response times. Takes 2-3 minutes.

If the script doesn't exist or needs updates, the key measurements to collect manually:

### API Response Times (use curl, not browser)
Time each endpoint 3 times and record median:
```bash
time curl -s "https://www.djinn.gg/api/health" > /dev/null
time curl -s "https://www.djinn.gg/api/idiot/browse?limit=20" > /dev/null
time curl -s "https://www.djinn.gg/api/odds?sport=basketball_nba" > /dev/null
time curl -s "https://www.djinn.gg/api/network/status" > /dev/null
time curl -s "https://www.djinn.gg/api/validators/discover" > /dev/null
```

### Validator Health
Fetch `https://www.djinn.gg/api/validators/discover`, then for each validator UID:
```bash
curl -s "https://www.djinn.gg/api/validators/{uid}/health"
```
Record: status, version, bt_connected, attest_capable, response time.

### Benchmarks (compare against these baselines from 2026-03-31)
| Metric | Baseline | Target |
|--------|----------|--------|
| /api/health | 142ms | <200ms |
| /api/idiot/browse | 1644ms cold, <100ms cached | <500ms cold |
| /api/odds | 261ms | <500ms |
| /api/network/status | 85ms cached | <300ms |
| /api/validators/discover | 68ms | <200ms |
| Signal tx send | 718ms | <1000ms |
| Signal tx confirm | 3000ms | <5000ms |
| Healthy validators | 4/7 | 3+ required |

## Phase 2: Visual Page Testing (browser)

Start a local server or use production (with pacing). Use Playwright MCP tools.

Screenshots go in `~/djinn/screenshots-tmp/` (create if needed).

### Critical User Flows (test these thoroughly)

**Flow A: New Idiot (buyer) journey**
1. `/` - Homepage loads, "I'm an Idiot" card visible
2. Click "I'm an Idiot" (client-side nav to `/idiot`)
3. Onboarding checklist visible with 5 steps
4. Navigate to `/idiot/browse` via "Browse and buy signals" link
5. Wait for signals to load (measure: how long until cards appear?)
6. Verify signal cards show: sport badge, time left, fee, SLA, max notional
7. Click first available signal (client-side nav to `/idiot/signal/{id}`)
8. Signal detail page loads with "Connect your wallet" prompt
9. Screenshot the full purchase page layout

**Flow B: New Genius (seller) journey**
1. `/genius` - Onboarding checklist with 5 steps
2. Click "Create your first signal" or navigate to `/genius/signal/new`
3. Signal creation page loads (connect prompt or sport selection)
4. Screenshot the creation flow

**Flow C: Leaderboard**
1. `/leaderboard` - Table renders with headers
2. Wait 5s for data to load
3. Verify either data rows or "No Geniuses" message appears (NOT stuck skeleton)
4. Quality Score explanation section visible below table

**Flow D: Network Status**
1. `/network` - Wait up to 15s for metagraph data
2. Verify: miner count, validator count, incentive chart, miner table
3. Click into a validator detail (e.g., `/network/validator/2`)

### Secondary Pages (quick check each loads)
- `/docs` - Has "Choose your path" section
- `/docs/how-it-works` - 6-step flow renders
- `/docs/api` - API reference with endpoints
- `/docs/contracts` - Contract addresses table
- `/docs/sdk` - SDK documentation
- `/attest` - URL input + "How it works" steps
- `/terms` - Full legal text with 20 sections
- `/privacy` - Privacy policy content
- `/about` - About page content
- `/education` - Education page content

### Error States
- `/nonexistent-page` - Returns 404 (not a crash)
- `/idiot/signal/999999` - Shows error or "connect wallet" (not a crash)

### Mobile (375x667)
- Resize viewport, check `/`, `/genius`, `/idiot`, `/idiot/browse`, `/leaderboard`
- Verify: no horizontal overflow, hamburger menu accessible, cards stack vertically
- Run: `document.body.scrollWidth <= 395` on each page

## Phase 3: Timing the Full Purchase UX

This is the most important test. Time every step a real user goes through:

### Signal Creation Timing (if wallet available)
Measure each step separately:
1. **Sport selection + game pick**: UI interaction time (instant)
2. **Validator discovery**: `discoverValidatorClients()` call
3. **Line check**: `resilientCheckLines()` (fans out to miners via validators)
4. **Encryption + Shamir split**: Client-side crypto (should be <500ms)
5. **Share distribution**: Parallel POST to validators
6. **On-chain commit**: Wallet sign + tx confirmation
7. **Total end-to-end**: From "Create Signal" click to success

### Purchase Timing (if wallet available)
1. **Signal detail load**: Time from navigation to data rendered
2. **Line check**: Miner availability verification
3. **MPC availability check**: Validator MPC computation (the big one: 30-90s)
4. **On-chain purchase**: Wallet sign + tx confirmation
5. **Share collection**: Key share retrieval from validators
6. **Decryption**: AES-GCM decrypt (should be instant)
7. **Total end-to-end**: From "Purchase" click to pick revealed

### Without Wallet
If no test wallet is available, use the ux-timing-test.mjs script for on-chain timing, and measure the UI steps by observing loading states and step transitions visually.

## Phase 4: Report

```markdown
# Djinn E2E Test Report - {date}

## Infrastructure Health
| Metric | Value | vs Baseline | Status |
|--------|-------|-------------|--------|
| Healthy validators | X/Y | 4/7 | OK/DEGRADED |
| /api/health | Xms | 142ms | OK/SLOW |
| /api/idiot/browse | Xms | 1644ms | OK/SLOW |
| ... | ... | ... | ... |

## User Flow Timing
| Flow | Step | Time | Status |
|------|------|------|--------|
| Browse | Page load | Xms | OK/SLOW |
| Browse | Signals appear | Xs | OK/SLOW |
| Purchase | Line check | Xs | OK/FAIL |
| Purchase | MPC check | Xs | OK/FAIL/TIMEOUT |
| Purchase | On-chain tx | Xs | OK/FAIL |
| Purchase | Total | Xs | OK/SLOW |

## Critical Issues (blocks launch)
- [description + evidence]

## Minor Issues
- [description]

## All Pages Status
| Page | Status | Load Time | Notes |
|------|--------|-----------|-------|
| / | OK/FAIL | Xms | ... |

## Comparison to Previous Run
[If previous report exists in test-results/, compare key metrics]
```

Save to `~/djinn/test-results/e2e-report-{date}.md`.

## Arguments

- No args: run all phases
- `quick`: Phase 1 (infra) + Phase 2 critical flows only
- `timing`: Phase 1 + Phase 3 only (needs wallet)
- `api`: Phase 1 only (fastest, no browser)
- Flow numbers (e.g., `A C`): run only specified flows from Phase 2
