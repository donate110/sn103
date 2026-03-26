# Contributing to Djinn Protocol

## Getting Started

1. Fork the repo and clone it locally
2. Follow the setup instructions in [README.md](README.md)
3. Create a feature branch from `main`

## Branch Naming

```
phase-N/component    # Major phase work (e.g., phase-3/web-client)
feat/short-desc      # New features
fix/short-desc       # Bug fixes
docs/short-desc      # Documentation only
```

## Commit Messages

- Use imperative mood: "Add feature" not "Added feature"
- First line under 72 characters
- Reference issue numbers when applicable: `Fix signal expiry check (#42)`

## Code Standards

### Solidity (contracts/)

- NatSpec on all public/external functions
- `forge fmt` must pass
- All state-changing functions must emit events
- ReentrancyGuard on functions that transfer tokens
- Target >90% test coverage

### Python (validator/, miner/)

- Type hints on all functions
- `ruff check` and `ruff format` must pass
- Structured logging via structlog (no bare print statements)
- pytest with `--cov-fail-under=80`

### TypeScript (web/)

- `pnpm lint` and `pnpm typecheck` must pass
- React components use functional style with hooks
- Error boundaries on all route segments
- All API calls wrapped in try/catch with user-facing error messages

## Testing

Every PR must have passing tests. Run the full suite before submitting:

```bash
# Contracts
cd contracts && forge test

# Validator
cd validator && python -m pytest

# Miner
cd miner && python -m pytest

# Web
cd web && pnpm vitest run
```

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Include a description of what changed and why
- Link related issues
- All CI checks must pass before merge
- Request review from at least one maintainer

## Whitepaper Deviations

If your implementation diverges from the [whitepaper](docs/whitepaper.md):

1. Append the deviation and reasoning to `DEVIATIONS.md`
2. Tag the PR with `[DEVIATION]` in the title
3. Deviations affecting economics, security, or user-facing behavior require explicit maintainer approval before merge
