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

## Clone & Setup

```bash
# Clone repository
git clone https://github.com/jablay46/yield-arbitrage.git
cd yield-arbitrage

# Install dependencies
npm install
forge install

# Configure environment
cp .env.example .env
# Edit .env with your settings (see below)
```

## Environment Variables

Edit `.env` file with the following:

```bash
# RPC URLs
BASE_RPC_URL=https://mainnet.base.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Private Keys (DO NOT COMMIT)
DEPLOYER_PRIVATE_KEY=your_private_key_here
ARBITER_PRIVATE_KEY=your_arbitrer_private_key

# Contract Addresses (Base Mainnet)
AAVE_POOL_V3_ADDRESS=0xA238Dd80C259a72e81d7e5224f0EE9dF6fe5B31
MORPHO_ADDRESS=0xBBf3D2a8dA5A3e1a7b7E8F2a9cF3dB4e5f6g7h8
MOONWELL_POOL_ADDRESS=0xFeec6D1eE8dD0f8C0a9E9f2F3B4c5D6e7F8g9h0
SWAP_ROUTER=0xE4eDD6f5f0e0fB8dB7c4e9F2a1D3C5e6F7g8h9i
```

## Build & Test

```bash
# Build contracts
forge build

# Run tests
forge test
```

## Deployment

### 1. Deploy ArbitrageExecutor Contract

```bash
# Deploy to Base Sepolia (testnet first!)
forge create --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $AAVE_POOL_V3_ADDRESS $MORPHO_ADDRESS $MOONWELL_POOL_ADDRESS $MOONWELL_POOL_ADDRESS $SWAP_ROUTER \
  contracts/ArbitrageExecutor.sol:ArbitrageExecutor
```

Or using cast:

```bash
cast send <CONTRACT_ADDRESS> "initialize(address,address,address,address,address)" \
  $AAVE_POOL_V3_ADDRESS $MORPHO_ADDRESS $MOONWELL_POOL_ADDRESS $MOONWELL_POOL_ADDRESS $SWAP_ROUTER \
  --rpc-url $BASE_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

### 2. Verify Contract

```bash
forge verify-contract <CONTRACT_ADDRESS> --rpc-url $BASE_RPC_URL
```

## Contract Addresses (Base Mainnet)

| Protocol | Address | Notes |
|----------|---------|-------|
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e5224f0EE9dF6fe5B31` | Main lending pool |
| Aave V3 Data Provider | `0x2d8A3C59C4F4F0d5c8e2E5f2A1d3C4e5F6g7h8` | For reserve data |
| Morpho | `0xBBf3D2a8dA5A3e1a7b7E8F2a9cF3dB4e5f6g7h8` | P2P lending |
| Moonwell | `0xFeec6D1eE8dD0f8C0a9E9f2F3B4c5D6e7F8g9h0` | Apollo |
| Uniswap V3 Router | `0xE4eDD6f5f0e0fB8dB7c4e9F2a1D3C5e6F7g8h9i` | For swaps |

> ⚠️ **Important**: Verify addresses at [Basescan](https://basescan.org) before deploying!

## Running the Bot

```bash
# Install Node.js dependencies
cd bot
npm install

# Configure bot settings
cp config.example.json config.json
# Edit config.json with your contract addresses

# Start the bot
npm run start

# Or run with PM2 for production
pm2 start bot/index.js
```

## Security

- Use multiple price oracles for price validation
- Set maximum trade size limits
- Implement slippage protection
- Monitor gas costs vs. potential profit
- Test extensively on testnet before mainnet
- Use separate wallets for deployment and execution

## License

MIT
