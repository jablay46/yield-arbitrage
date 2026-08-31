# Yield Arbitrage Bot

A yield arbitrage trading bot with flashloan support for the Base network. Monitors lending protocol rates and executes arbitrage opportunities automatically.

## Features

- **Flashloan Integration**: Aave V3, Morpho, Moonwell
- **Real-time Rate Monitoring**: Continuous monitoring of lending rates
- **Automated Arbitrage**: Detects and executes yield spread opportunities
- **Risk Management**: Built-in risk engine and PnL tracking
- **TypeScript Bot**: Off-chain monitoring and transaction building

## Smart Contracts

| Contract | Description |
|----------|-------------|
| `FlashloanArbitrage.sol` | Core flashloan receiver |
| `ArbitrageExecutor.sol` | Lending protocol arbitrage logic |
| `AaveAdapter.sol` | Aave V3 integration |
| `MorphoAdapter.sol` | Morpho integration |
| `MoonwellAdapter.sol` | Moonwell integration |

## Bot Components

| File | Description |
|------|-------------|
| `rate-monitor.ts` | Real-time lending rate monitoring |
| `opportunity-filter.ts` | Profitability filtering |
| `tx-builder.ts` | Transaction construction |
| `risk-engine.ts` | Risk assessment |
| `pnl-tracker.ts` | Profit/Loss tracking |

## Setup

1. Install dependencies:
```bash
npm install
forge install
```

2. Configure environment:
```bash
cp .env.example .env
# Fill in your RPC URLs and private keys
```

3. Build contracts:
```bash
forge build
```

4. Run tests:
```bash
forge test
```

## Deployment

Deploy to Base mainnet:
```bash
forge script script/Deploy.s.sol --rpc-url $BASE_RPC --broadcast --verify
```

## Security

- Use multiple price oracles for price validation
- Set maximum trade size limits
- Implement slippage protection
- Monitor gas costs vs. potential profit

## License

MIT
