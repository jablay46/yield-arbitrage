# AGENTS.md

Repository-specific notes for the yield-arbitrage project (Base mainnet leveraged yield looping).

## Tooling

- Contracts: Foundry (`forge`). Not pre-installed in this env; install via `curl -sL https://foundry.paradigm.xyz | bash` then `foundryup`. Add `~/.foundry/bin` to PATH.
- Bot: TypeScript (viem + vitest) under `bot/`. `npm install` then `npm run build` (tsc) and `npm test` (vitest).
- Submodules (`lib/forge-std`, `lib/openzeppelin-contracts`) are vendored; `forge build` works without `git submodule update --init`.

## Build / test commands

- `forge build` — compiles contracts (warnings are lint notes, not errors).
- `forge test` — full Base fork suite (43/43). Needs `BASE_RPC_URL`; `FORK_BLOCK` is optional (defaults to 50M). Tests pass at the pinned block and at the latest block.
- `cd bot && npm run build && npm test` — bot type-check + 78 unit tests.

## Known test caveats

- The suite is **green**: `forge test` 43/43 and bot `npm test` 78/78, both at the pinned `FORK_BLOCK=50000000` and at the latest Base block. Earlier notes about `test_openLoop_2x_aave_source` failing are obsolete — pinning `evm_version = "prague"` (in `foundry.toml`) activates the opcodes the Aave Pool uses, and the Aave-source path now passes.
- Aave V3 `repay` rejects the `type(uint256).max` sentinel when repaying `onBehalfOf` another address (`NoExplicitAmountToRepayOnBehalf`) — fork tests that repay the executor's debt externally must pass the explicit debt amount.
- `FORK_BLOCK` is optional: omit it to fork latest, or set it for reproducibility. Both modes pass.

## Architecture pointers

- `contracts/LoopingExecutor.sol` — leveraged open/close via Morpho (primary, 0 fee) or Aave flashloan. Persists the opened asset pair in `openPosition` and validates `closeLoop` against it. The health-factor floor is enforced both in `setMinHealthFactor` and in `_executeOpen` (per-call overrides are clamped up to `MIN_HEALTH_FACTOR_FLOOR`). `keeperDeleverage` is intentionally **not** `whenNotPaused`, so a paused executor (rate-feed circuit breaker) can still wind down a critical position; on a cross-asset close it enforces an oracle-derived `minSwapOut` (5% slippage) so a malicious keeper can't pair adverse router calldata with a zero floor. `resetPosition` is the owner escape hatch for a position unwound out-of-band (zero debt but stale `positionOpen` flag); `emergencyWithdraw` also blocks the active collateral's aToken while a position is open.
- `contracts/security/SecurityUtils.sol` — two-step ownership (`Ownable2Step`), `ReentrancyGuard`, `Pausable`. `renounceOwnership` clears `pendingOwner`; `transferOwnership(address(0))` cancels a pending transfer.
- `bot/src/strategy/find-candidates.ts` — ranks loop candidates; liquidity is checked per leverage level, not only at 5x.
- `bot/src/monitor/rate-monitor.ts` — multicalls reserve + config + aToken balanceOf + variableDebtToken totalSupply; `utilizationBps` derived from debt/(debt+liquidity).
- `bot/src/orchestrator/tx-builder.ts` — simulates then sends via raw `sendTransaction` with an explicit, rollback-on-failure nonce tracker. RBF replacement resubmits the encoded `to`/`data` (same calldata), re-applies the `maxGasPriceGwei` cap, and renews the receipt deadline; when both fees are already at the cap no replacement is sent (a same-fee resubmission would be rejected as underpriced) and the original tx is awaited. Exposes `setEMode` for the e-mode preflight and `keeperDeleverage` for the paused-executor emergency path.
- `bot/src/index.ts` `maybeOpen` — e-mode preflight: when the best candidate needs ETH-correlated e-mode (5x), the bot calls `setEMode(1)` on the executor before approve/open, so the operator doesn't have to remember a manual step. `healthCycle` closes via `closeLoop` normally but falls back to `keeperDeleverage` when the executor is paused (closeLoop is `whenNotPaused`), and resets e-mode to 0 after closing a position that used the preflight (`emodeApplied` is persisted in the position file).

## Style

- Minimal comments; only document non-obvious invariants.
- Keep changes focused; modify existing files rather than creating variants.
