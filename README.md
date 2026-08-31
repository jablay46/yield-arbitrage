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
| `contracts/security/SecurityUtils.sol` | two-step ownership, pausable, reentrancy guard, emergency withdraw |
| `contracts/libraries/RateMath.sol` | health factor math (WAD) |
| `contracts/interfaces/*` | Aave V3 + Morpho Blue interfaces |

## Development

```bash
foundryup            # install forge
forge install        # fetch dependencies (git submodules in lib/)
forge build
forge test --fork-url https://mainnet.base.org   # 16/16 — real Base state
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

```bash
cd bot
npm install
npm test              # unit tests (32)
npm run build
cp ../.env.example ../.env  # configure, keep DRY_RUN=true to monitor only
npm start
```

Every live send is pre-simulated with `simulateContract`; a failing simulation
never reaches the mempool.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EXECUTOR_ADDRESS` | — | deployed LoopingExecutor |
| `EXECUTOR_PRIVATE_KEY` | — | owner key (live mode only) |
| `MARGIN_ASSET` / `MARGIN_AMOUNT` | WETH / 1e18 | margin token + amount |
| `LEVERAGE` | 2 | allowed: 2, 3, 5 |
| `DRY_RUN` | true | simulate only |
| `AUTO_TRADE` | false | open the best loop automatically |
| `MIN_NET_APY_BPS` | 50 | minimum yearly net yield on margin |

## Risk warnings

- **Interest-rate risk**: borrow APR can exceed supply APY (the loop turns
  negative). The bot ranks candidates by live rates — check the net APY.
- **Liquidation**: HF falls when debt grows faster than collateral yield.
  5x leverage is only possible in e-mode (LT 90%) and is risky: HF 1.125 at open.
- **Cross-asset loops** add price risk — the swap callback enforces atomic
  solvency (`minSwapOut`, debt must be coverable at execution price).
- **Operator mistake**: only the executor owner can open/close; keep the key
  cold. 3-of-5 multisig setup is strongly recommended (unimplemented yet).

Software status: contracts fork-tested against the real Base state;
bot unit-tested and smoke-tested on live data. Auditing by a third party is
still required before deploying real funds.
