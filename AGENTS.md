# AGENTS.md

Repository-specific notes for the yield-arbitrage project (Base mainnet leveraged yield looping).

## Tooling

- Contracts: Foundry (`forge`). Not pre-installed in this env; install via `curl -sL https://foundry.paradigm.xyz | bash` then `foundryup`. Add `~/.foundry/bin` to PATH.
- Bot: TypeScript (viem + vitest) under `bot/`. `npm install` then `npm run build` (tsc) and `npm test` (vitest).
- Submodules (`lib/forge-std`, `lib/openzeppelin-contracts`) are vendored; `forge build` works without `git submodule update --init`.

## Build / test commands

- `forge build` — compiles contracts (warnings are lint notes, not errors).
- `forge test` — full Base fork suite (19/19). Needs `BASE_RPC_URL`; `FORK_BLOCK` is optional (defaults to 50M). Tests pass at the pinned block and at the latest block.
- `cd bot && npm run build && npm test` — bot type-check + 60 unit tests.

## Known test caveats

- The suite is **green**: `forge test` 19/19 and bot `npm test` 60/60, both at the pinned `FORK_BLOCK=50000000` and at the latest Base block. Earlier notes about `test_openLoop_2x_aave_source` failing are obsolete — pinning `evm_version = "prague"` (in `foundry.toml`) activates the opcodes the Aave Pool uses, and the Aave-source path now passes.
- `FORK_BLOCK` is optional: omit it to fork latest, or set it for reproducibility. Both modes pass.

## Architecture pointers

- `contracts/LoopingExecutor.sol` — leveraged open/close via Morpho (primary, 0 fee) or Aave flashloan. Persists the opened asset pair in `openPosition` and validates `closeLoop` against it.
- `contracts/security/SecurityUtils.sol` — two-step ownership (`Ownable2Step`), `ReentrancyGuard`, `Pausable`. `renounceOwnership` clears `pendingOwner`; `transferOwnership(address(0))` cancels a pending transfer.
- `bot/src/strategy/find-candidates.ts` — ranks loop candidates; liquidity is checked per leverage level, not only at 5x.
- `bot/src/monitor/rate-monitor.ts` — multicalls reserve + config + aToken balanceOf + variableDebtToken totalSupply; `utilizationBps` derived from debt/(debt+liquidity).
- `bot/src/orchestrator/tx-builder.ts` — simulates then sends using the simulation `request` and `estimateContractGas` + `applyGasBuffer`. Exposes `setEMode` for the e-mode preflight.
- `bot/src/index.ts` `maybeOpen` — e-mode preflight: when the best candidate needs ETH-correlated e-mode (5x), the bot calls `setEMode(1)` on the executor before approve/open, so the operator doesn't have to remember a manual step.

## Style

- Minimal comments; only document non-obvious invariants.
- Keep changes focused; modify existing files rather than creating variants.
