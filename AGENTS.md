# AGENTS.md

Repository-specific notes for the yield-arbitrage project (Base mainnet leveraged yield looping).

## Tooling

- Contracts: Foundry (`forge`). Not pre-installed in this env; install via `curl -sL https://foundry.paradigm.xyz | bash` then `foundryup`. Add `~/.foundry/bin` to PATH.
- Bot: TypeScript (viem + vitest) under `bot/`. `npm install` then `npm run build` (tsc) and `npm test` (vitest).
- Submodules (`lib/forge-std`, `lib/openzeppelin-contracts`) are vendored; `forge build` works without `git submodule update --init`.

## Build / test commands

- `forge build` — compiles contracts (warnings are lint notes, not errors).
- `forge test --match-path test/RateMathFuzz.t.sol` — pure math fuzz tests, no RPC needed.
- `forge test` — full suite incl. Base fork tests. Fork tests require `BASE_RPC_URL` / `FORK_BLOCK`.
- `cd bot && npm run build && npm test` — bot type-check + 42 unit tests.

## Known test caveats

- `test_openLoop_2x_aave_source` fails on the default `FORK_BLOCK=50000000` because the Aave V3 Pool implementation at that height uses opcodes the local EVM spec does not activate (`NotActivated` halt on the Aave flashloan path). At older blocks (e.g. 30M) the opcode path works but the `assertApproxEqAbs(..., 2)` collateral assertion is too tight for supply rounding. This is a fork-block/assertion-sensitivity issue, not a code bug.
- Morpho-sourced loop tests (2x/3x/5x e-mode) pass on the default fork block.

## Architecture pointers

- `contracts/LoopingExecutor.sol` — leveraged open/close via Morpho (primary, 0 fee) or Aave flashloan. Persists the opened asset pair in `openPosition` and validates `closeLoop` against it.
- `contracts/security/SecurityUtils.sol` — two-step ownership (`Ownable2Step`), `ReentrancyGuard`, `Pausable`. `renounceOwnership` clears `pendingOwner`; `transferOwnership(address(0))` cancels a pending transfer.
- `bot/src/strategy/find-candidates.ts` — ranks loop candidates; liquidity is checked per leverage level, not only at 5x.
- `bot/src/monitor/rate-monitor.ts` — multicalls reserve + config + aToken balanceOf + variableDebtToken totalSupply; `utilizationBps` derived from debt/(debt+liquidity).
- `bot/src/orchestrator/tx-builder.ts` — simulates then sends using the simulation `request` and `estimateContractGas` + `applyGasBuffer`.

## Style

- Minimal comments; only document non-obvious invariants.
- Keep changes focused; modify existing files rather than creating variants.
