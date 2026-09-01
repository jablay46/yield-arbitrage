# Leveraged Yield Looping on Base

Leveraged looping executor with flashloans on **Base mainnet** — built to run
real transactions on Aave V3 with free flashloans from Morpho Blue.

## Strategy

For a margin `C` and leverage `L` (2x/3x/5x) on the same asset:

1. Flashloan `(L−1)·C` from Morpho Blue (0% fee) or Aave V3 (5 bps premium).
2. Supply margin + flashloan → Aave V3 as collateral (`L·C`).
3. Borrow `(L−1)·C` + premium against it.
4. Repay the flashloan. Result: leveraged supply position.

Net APY on the margin = `L·supplyAPY − (L−1)·borrowAPR`. The loop earns when
the supply yield beats the borrow cost; the built-in health-factor guard
(`HF = L·LT/(L−1)`, must stay ≥ 1.05 by default) blocks unsafe opens.
Unwinding (`closeLoop`) is flashloan-powered and returns the margin in one tx.

## Contracts

| File | Purpose |
|---|---|
| `contracts/LoopingExecutor.sol` | open/close loops; leverage 2x/3x/5x; same-asset mode plus cross-asset mode via the pool's atomic swap callback (atomicLoop model) |
| `contracts/FlashloanBase.sol` | Aave V3 + Morpho Blue flashloan base with initiator validation |
| `contracts/security/SecurityUtils.sol` | thin wrapper over OpenZeppelin's audited Ownable2Step, ReentrancyGuard, and Pausable — plus pause/unpause and a `ZeroAddress` error |
| `contracts/interfaces/*` | Aave V3 + Morpho Blue interfaces |

## Development

```bash
foundryup            # install forge
forge install        # fetch dependencies (git submodules in lib/)
forge build
forge test --fork-url https://mainnet.base.org   # 19/19 — real Base state
```

## Deployment

```bash
cp .env.example .env   # fill DEPLOYER_PRIVATE_KEY
source .env
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
```

## Bot (TypeScript)

Monitors **real** Aave V3 rates, ranks leveraged loop candidates, watches the
on-chain health factor, and deleverages when it drops below the critical
threshold. Defaults to dry-run — it never sends a transaction unless you
opt in.

- **Real USD valuation**: margin is priced via the Aave PriceOracle, so the
  `MAX_MARGIN_USD` guard is actually enforced (not bypassed).
- **Restart safety**: before opening, the bot reads the on-chain
  `positionOpen()` flag so a restart never attempts a redundant open that the
  contract would reject.
- **Realized PnL**: on close, PnL is estimated from the net APY captured at
  open over the hold duration, minus gas spent on open + close (priced via
  the oracle). Persisted to `data/pnl.json`.

```bash
cd bot
npm install
npm test              # unit tests (60)
npm run build
cp ../.env.example ../.env  # configure, keep DRY_RUN=true to monitor only
npm start
```

Every live send is pre-simulated with `simulateContract`; a failing simulation
never reaches the mempool. When a candidate needs ETH-correlated e-mode (5x),
the bot sets e-mode category 1 on the executor before opening.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXECUTOR_ADDRESS` | — | deployed LoopingExecutor |
| `EXECUTOR_PRIVATE_KEY` | — | owner key (live mode only) |
| `BASE_RPC_URL` | `https://mainnet.base.org` | optional HTTP endpoint for read fallback and wallet transactions; without `BASE_WS_URL`, `USE_PENDING_BLOCK` reads/simulations use it |
| `BASE_WS_URL` | — | optional WebSocket endpoint (Flashblocks-speed reads) |
| `MARGIN_ASSET` / `MARGIN_AMOUNT` | WETH / 1e18 | margin token + amount |
| `LEVERAGE` | 2 | allowed: 2, 3, 5 |
| `DRY_RUN` | true | simulate only |
| `AUTO_TRADE` | false | open the best loop automatically |
| `MIN_NET_APY_BPS` | 50 | minimum yearly net yield on margin |
| `POLL_INTERVAL_MS` | 30000 | how often rates are refreshed / candidates re-ranked |
| `HEALTH_CHECK_INTERVAL_MS` | 60000 | how often the on-chain health factor is polled |
| `PRICE_CACHE_TTL_MS` | 30000 | oracle price cache lifetime (avoids an RPC per cycle) |
| `USE_PENDING_BLOCK` | true | simulate/read against the Flashblock preconfirmation block |

## Test status

- Fork suite (real Base mainnet state): **19/19 passing** — pinned to
  `evm_version = "prague"` so Aave's recent-block opcodes activate. Runs at
  the pinned `FORK_BLOCK=50000000` and at the latest block.
- Bot unit tests: **60/60 passing** — `npm test`
- E2E (anvil fork of Base): the `forge test` suite covers the full cycle
  approve → openLoop 2x → closeLoop (see `test_closeLoop_returns_margin`); no
  standalone anvil script is shipped.

## Gas snapshot (Base mainnet fork)

| Function | Gas used |
|---|---|
| openLoop 2x (Morpho source) | ~480k |
| openLoop 2x (Aave source) | ~470k |
| closeLoop | ~645k |

At 0.01 gwei Base fees both are well under $0.01.

## Risk warnings

- **Interest-rate risk**: borrow APR can exceed supply APY (the loop turns
  negative). The bot ranks candidates by live rates — check the net APY.
- **Liquidation**: HF falls when debt grows faster than collateral yield.
  5x leverage is only possible in e-mode (LT 90%) and is risky: HF 1.125 at open.
  Health checks occur every `HEALTH_CHECK_INTERVAL_MS` (default 60s); a fast
  collateral-price crash between reads can still reach liquidation before the
  next poll, so lower the interval (at higher RPC cost) or use a custom oracle
  for volatile pairs.
- **Cross-asset loops** add price risk — the swap callback enforces atomic
  solvency (`minSwapOut`, debt must be coverable at execution price). The
  swap router is a trusted, owner-set component: a malicious router could
  reenter the flashloan callback. Only use a router you fully control.
  Emergency closes from a low health factor pass `minSwapOut = 0`, so
  cross-asset positions have no slippage guard on the unwind swap; prefer
  same-asset loops where the close needs no swap.
- **Operator mistake**: only the executor owner can open/close; keep the key
  cold. 3-of-5 multisig setup is strongly recommended (unimplemented yet).
- **PnL is an estimate**: realized PnL is derived from the net APY at open
  over the hold duration minus gas — it is not a balance-delta measurement.
  Treat `data/pnl.json` as an indicative accounting aid, not audited PnL.

Software status: contracts fork-tested against the real Base state; security
primitives delegate to OpenZeppelin's audited libraries. Bot unit-tested and
smoke-tested on live data. Auditing by a third party is still required before
deploying real funds.
