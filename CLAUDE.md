# Djinn Protocol

## What This Is
Djinn unbundles information from execution in sports betting. Analysts (Geniuses) sell encrypted predictions. Buyers (Idiots) purchase access. Signals stay secret via Shamir sharing and MPC. Track records are publicly verifiable on-chain from finalized audit settlements. Built on Bittensor Subnet 103 and Base chain, settled in USDC.

## Source of Truth
- `djinn/docs/whitepaper.md` is the DESIGN INTENT
- The whitepaper describes WHAT and WHY. Implementation determines HOW.
- When implementation reveals that the whitepaper is wrong, incomplete, or suboptimal:
  1. Append the deviation and reasoning to `DEVIATIONS.md` at the project root
  2. Continue building the better approach
  3. Flag it as [DEVIATION] in the task list so it can be reviewed
- Only stop and ask before proceeding if the deviation changes user-facing behavior or economic outcomes (fee math, settlement logic, security guarantees)
- Internal architecture, data flow, crypto implementation details: make the right call and document it

## Tech Stack
- **Smart Contracts:** Solidity, Foundry (forge) for testing/deployment, Base chain (UUPS proxies, TimelockController governance)
- **Web Client:** Next.js 14 (app router), TypeScript, Tailwind, ethers.js v6
- **Bittensor Validators:** Python 3.11+, bittensor SDK, MPC (Beaver triples, OT-based triple generation)
- **Bittensor Miners:** Python 3.11+, TLSNotary for web attestations
- **Indexing:** The Graph (subgraph in AssemblyScript)
- **Package managers:** pnpm for JS/TS, uv for Python

## Project Structure
```
djinn/
├── contracts/          # Foundry project -- Solidity (UUPS proxies)
├── web/                # Next.js client application
├── validator/          # Bittensor validator (Python, MPC orchestrator)
├── miner/              # Bittensor miner (Python, TLSNotary prover)
├── subgraph/           # The Graph subgraph (AssemblyScript)
├── docs/               # Whitepaper and specs
├── scripts/            # Deployment, setup, utilities
├── DEVIATIONS.md       # Append-only log of whitepaper deviations
└── KICKOFF.md          # Build kick-off prompt (reference only)
```

## Autonomous Operation Rules
- DO make architectural decisions without asking. Document them in code comments.
- DO launch parallel subagents for independent workstreams.
- DO write comprehensive tests for everything. Target >90% coverage on contracts.
- DO create task lists to track progress across sessions.
- DO update DEVIATIONS.md whenever implementation diverges from the whitepaper.
- STOP and ask before: deploying to any network, spending money, or choosing between approaches where both have major tradeoffs that affect users or economics.
- When blocked on something that needs human action (API keys, deployment, running infra, purchasing services), create a task tagged [BLOCKED:HUMAN] and move to the next unblocked workstream.
- When deviating from the whitepaper on economics, security, or user-facing behavior, create a task tagged [DEVIATION:REVIEW] and do not build further on that assumption until confirmed.

## Testing Requirements
- **Contracts:** Foundry unit tests + integration tests + fuzz tests on all financial math
- **Validator/Miner:** pytest with mocked network layer
- **Web client:** Vitest unit tests + Playwright E2E for critical flows
- **Every component must have passing tests before moving to the next phase**

## Git Workflow
- **Repo:** `djinn-inc/djinn` on GitHub. Building in public.
- **Branching:** Feature branch per phase. Merge to `main` when the phase passes all tests.
- **Commit cadence:** Commit after each meaningful unit of work (one contract + its tests, one major client flow). Descriptive messages.
- **Push cadence:** Push at the end of every session and after completing each major component within a phase. Never let unpushed work accumulate across sessions.
- **Do NOT push secrets.** Use `.env` files (gitignored) for API keys, private keys, RPC URLs. A `.env.example` with placeholder values goes in the repo.

## Code Standards
- No comments explaining obvious code
- Error messages must be actionable
- All contract functions must have NatSpec
- All Python must have type hints
