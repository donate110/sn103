<div align="center">

# **Djinn Protocol** <!-- omit in toc -->

### Intelligence × Execution

Buy intelligence you can trust.
Sell analysis you can prove.
Signals stay secret forever — even from us.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/Djinn-Inc/djinn/actions/workflows/ci.yml/badge.svg)](https://github.com/Djinn-Inc/djinn/actions/workflows/ci.yml)

---

Bittensor Subnet 103 · Base Chain · USDC

[Whitepaper](docs/whitepaper.md) · [djinn.gg](https://djinn.gg)
</div>

---

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Web Attestation](#web-attestation)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Running a Validator](#running-a-validator)
- [Running a Miner](#running-a-miner)
- [Hardware Requirements](#hardware-requirements)
- [Observability](#observability)
- [Development](#development)
- [Contract Addresses](#contract-addresses)
- [License](#license)

---

## Overview

Djinn unbundles information from execution. Analysts (**Geniuses**) sell encrypted predictions. Buyers (**Idiots**) purchase access. Signals stay secret forever. Track records are verifiable forever. The protocol runs itself.

Read the full [Whitepaper](docs/whitepaper.md) for complete protocol details.

### Two Core Guarantees

1. **Signals stay secret forever.** No entity, including Djinn, ever views signal content.
2. **Track records are verifiable forever.** Cryptographic proof confirms ROI and performance without revealing individual picks.

---

## How It Works

- **Geniuses** post encrypted signals with collateral-backed SLA guarantees
- **Idiots** purchase signals based on verifiable track records
- **Miners** verify real-time betting line availability via TLSNotary proofs
- **Validators** hold Shamir key shares, coordinate MPC, and attest game outcomes
- **Smart contracts** on Base handle escrow, collateral, and ZK-verified audit settlement

---

## Architecture

| Component | Location |
|-----------|----------|
| Smart contracts | Base chain (Escrow, Collateral, Audit, Account, CreditLedger, TrackRecord, ZK Verification) |
| Signal commitments | Base chain (immutable, timestamped, encrypted) |
| Data indexing | The Graph (open-source subgraph) |
| Key shares | Bittensor validators (Shamir + SPDZ MPC) |
| Line verification | Bittensor miners (TLSNotary-attested) |
| Web attestation | Bittensor validators + miners (TLSNotary, alpha burn gate) |
| Outcome attestation | Bittensor validators (2/3+ consensus) |
| ZK proof generation | Client-side only (snarkjs, Groth16) |
| Frontend | Next.js 14 (app router) |
| Admin dashboard | Grafana (4 dashboards: validator, miner, protocol, system) |

---

## Web Attestation

Djinn provides a public web attestation service at [djinn.gg/attest](https://djinn.gg/attest). Generate a cryptographic TLSNotary proof that any HTTPS website served specific content at a specific time.

**How it works:**
1. Burn **0.0001 TAO** (~$0.02) of SN103 alpha to the burn address
2. Enter the URL and your burn transaction hash at djinn.gg/attest
3. A validator dispatches the request to a miner
4. The miner generates a TLSNotary proof (30-90s)
5. The validator verifies the proof and returns it to you

**Use cases:** Legal evidence, journalism verification, governance transparency, academic citations.

**Burn address:** `5E9tjcvFc9F9xPzGeCDoSkHoWKWmUvq4T4saydcSGL5ZbxKV`

---

## Repository Structure

```
djinn/
├── contracts/           # Solidity smart contracts (Foundry)
│   ├── src/             # Contract source (Escrow, Collateral, Audit, etc.)
│   ├── test/            # Foundry tests (unit, fuzz, integration)
│   └── script/          # Deployment scripts (Deploy.s.sol)
├── circuits/            # circom 2 ZK circuits + snarkjs
│   ├── src/             # Circuit source (audit_proof, track_record)
│   └── test/            # Proof generation/verification tests
├── web/                 # Next.js 14 client application
│   ├── app/             # App router pages (browse, create, attest, admin)
│   ├── components/      # React components + tests
│   └── lib/             # Crypto, contracts, API, hooks
├── validator/           # Bittensor validator (Python)
│   ├── djinn_validator/ # Core package (API, MPC, scoring, chain, burn ledger)
│   └── tests/           # pytest suite (857 tests)
├── miner/               # Bittensor miner (Python)
│   ├── djinn_miner/     # Core package (API, checker, TLSNotary)
│   └── tests/           # pytest suite (326 tests)
├── djinn/               # Shared Python package (protocol constants, types)
├── subgraph/            # The Graph subgraph (AssemblyScript)
│   ├── src/             # Event handlers
│   └── abis/            # Contract ABIs
├── docs/                # Whitepaper, running guides, specs
├── scripts/             # Deployment and operational scripts
└── DEVIATIONS.md        # Whitepaper deviation log
```

---

## Getting Started

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, cast, anvil)
- [Node.js](https://nodejs.org/) 20+ with [pnpm](https://pnpm.io/)
- [Python](https://www.python.org/) 3.11+ with [uv](https://docs.astral.sh/uv/)
- [circom](https://docs.circom.io/getting-started/installation/) 2 (for ZK circuits)

### Local Development

```bash
# Clone
git clone https://github.com/Djinn-Inc/djinn.git
cd djinn

# Start local stack (Anvil + Validator + Miner + Web)
cp validator/.env.example validator/.env
cp miner/.env.example miner/.env
cp web/.env.example web/.env
docker compose up
```

Or run components individually:

```bash
# Smart contracts
cd contracts && forge build && forge test -vvv

# Validator
cd validator && uv sync && uv run pytest

# Miner
cd miner && uv sync && uv run pytest

# Web client
cd web && pnpm install && pnpm dev

# ZK circuits
cd circuits && npm install && npm test
```

---

## Running a Validator

Validators hold Shamir key shares, coordinate MPC for executability checks, and attest game outcomes.

```bash
cd validator
cp .env.example .env
# Edit .env with your Bittensor wallet, RPC URL, etc.
uv sync
uv run djinn-validator
```

See [Running on Testnet](./docs/running_on_testnet.md) and [Running on Mainnet](./docs/running_on_mainnet.md) for detailed setup.

---

## Running a Miner

Miners verify real-time betting line availability and generate TLSNotary proofs.

```bash
cd miner
cp .env.example .env
# Edit .env with your Bittensor wallet, API keys, etc.
uv sync
uv run djinn-miner
```

See [Running on Testnet](./docs/running_on_testnet.md) and [Running on Mainnet](./docs/running_on_mainnet.md) for detailed setup.

---

## Hardware Requirements

### Validator

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disk | 40 GB SSD | 100 GB SSD |
| Network | 100 Mbps | 1 Gbps |

Validators run the API server, MPC coordination, outcome attestation, and burn ledger. MPC operations are CPU-intensive during purchase flows.

### Miner

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 4 cores | 8+ cores |
| RAM | 8 GB | 16 GB |
| Disk | 20 GB SSD | 50 GB SSD |
| Network | 100 Mbps | 1 Gbps |

Miners run TLSNotary proof generation (30-90s CPU per attestation) and sports line checking. CPU is the bottleneck for TLSNotary MPC.

---

## Observability

The validator and miner expose Prometheus metrics at `/metrics`. A full observability stack is included:

- **Prometheus** — scrapes validator and miner metrics every 15s
- **Grafana** — 4 pre-built dashboards:
  - **Validator Dashboard** — shares stored, MPC sessions, attestation latency, burn gate rejections
  - **Miner Dashboard** — health checks, TLSNotary proof times, challenge responses
  - **Protocol Dashboard** — purchases processed, outcomes attested, weight updates
  - **System Dashboard** — CPU, memory, disk, network

```bash
# Start the observability stack
docker compose -f docker-compose.monitoring.yml up
# Grafana at http://localhost:3001 (admin/admin)
```

---

## Development

### Testing

```bash
# All contract tests (unit + fuzz + integration)
cd contracts && forge test -vvv

# Validator tests (857 tests)
cd validator && uv run pytest

# Miner tests (326 tests)
cd miner && uv run pytest

# Web unit + component tests (343 tests)
cd web && pnpm vitest run

# Web E2E tests
cd web && pnpm test:e2e

# ZK circuit tests
cd circuits && npm test
```

### Docker

```bash
# Full local stack
docker compose up

# Integration tests
docker compose -f docker-compose.yml -f docker-compose.test.yml up --build
```

### Deployment

```bash
# Deploy contracts to Base Sepolia
DEPLOYER_KEY=0x... ./scripts/deploy_base.sh sepolia

# Update subgraph addresses
./scripts/update_subgraph.sh --signal 0x... --escrow 0x... [...]
```

---

## Contract Addresses

Base Sepolia (testnet):

| Contract | Address |
|----------|---------|
| SignalCommitment | `0x83F38eA8B66634643E6FEC8F18848DAa0c86F6DE` |
| Escrow | `0x06e6d123DD2474599579B648dd56973120CcEFcA` |
| Collateral | `0x06AAfF8643e99042f86f1EC93ED8A8BD36d6D9E7` |
| Account | `0x7f5700896051f4af0F597135A39a6D9D24F8B2af` |
| CreditLedger | `0x09de6d7B81ED73707364ee772eAdA7c191c8a4FC` |
| TrackRecord | `0xd3FA108474eb4EfC79649a17472c5F7d729Ac08b` |
| Audit | `0x4ca56d7e1D10Ec78C26C98a39b17f83Ca85b68c3` |
| KeyRecovery | `0xbc88df681d3d40b3977e3693385f643166b7f54a` |
| USDC (Test) | `0x99b566222EED94530dF3E8bdbd8Da1BBe8cC7a69` |

---

## License

This repository is licensed under the MIT License. See [LICENSE](LICENSE) for details.
