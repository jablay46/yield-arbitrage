# 1. OBJECTIVE

Membangun sistem **Yield Arbitrage Bot** lengkap dengan flashloan di jaringan Base, yang mencakup:
- **Off-chain Monitoring Bot** - mendeteksi peluang arbitrage real-time
- **Orchestrator** - mengkoordinasikan workflow execution
- **Position Manager** - mengelola posisi dan risk parameters
- **Smart Contract (Solidity)** - flashloan receiver dan execution logic
- **Flashloan Integration** - Morpho, Aave (Spark), Moonwell

## Problem Statement
Lending protocol arbitrage: memanfaatkan spread antara supply rate dan borrow rate di berbagai protokol lending. Dengan flashloan, modal sendiri tidak diperlukan - cukup modal flashloan untuk ekssekusi atomic.

---

# 2. CONTEXT SUMMARY

## Network & Protocol Landscape (Base Network)

| Protocol | Type | Flashloan Support | TVL (Base) |
|----------|------|-------------------|------------|
| **Aave V3 (Spark)** | Lending | ✅ Yes (0.09% fee) | High |
| **Morpho** | Lending | ✅ Yes (Blue/Standard) | Growing |
| **Moonwell** | Lending | ✅ Yes | Medium |

## Arbitrage Strategy: Lending Protocol

**Target: Stablecoin Yield Spread**

```
Contoh Skenario:
┌─────────────────────────────────────────────────────────────┐
│  Step 1: Flashloan 100,000 USDC                             │
│     ↓                                                        │
│  Step 2: Supply ke Protocol A (APY 5%)                      │
│     ↓                                                        │
│  Step 3: Borrow DAI dari Protocol B (APR 3%)                │
│     ↓                                                        │
│  Step 4: Swap DAI → USDC                                     │
│     ↓                                                        │
│  Step 5: Repay flashloan + fee (0.09%)                      │
│     ↓                                                        │
│  Step 6: Withdraw dari Protocol A                           │
│     ↓                                                        │
│  PROFIT = Spread (5% - 3%) - Flashloan Fee                  │
└─────────────────────────────────────────────────────────────┘
```

## Component Dependencies

```
┌─────────────────────────────────────────────────────────────────┐
│                    ARBITRAGE SYSTEM ARCHITECTURE                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │  Monitoring  │────▶│ Orchestrator │────▶│   Position   │   │
│  │     Bot      │     │              │     │   Manager    │   │
│  └──────────────┘     └──────────────┘     └──────────────┘   │
│         │                    │                    │            │
│         ▼                    ▼                    ▼            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Smart Contract (Flashloan Receiver)         │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                  │   │
│  │  │  Aave   │  │ Morpho  │  │Moonwell │                  │   │
│  │  │(Spark)  │  │         │  │         │                  │   │
│  │  └─────────┘  └─────────┘  └─────────┘                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Constraints
- **Gas Cost**: Base memiliki gas rendah (~0.001-0.01 ETH per tx)
- **Block Time**: ~2 detik
- **Flashloan Fee**: Aave 0.09%, Morpho varies
- **Slippage Tolerance**: Harus diperhitungkan dalam profit calculation

## Tech Stack

### Smart Contracts
- **Language**: Solidity ^0.8.20
- **Framework**: Foundry (forge)
- **Libraries**: OpenZeppelin

### Off-Chain Bot (Node.js + TypeScript)
- **Runtime**: Node.js 20+
- **Language**: TypeScript 5.x
- **Web3 Library**: viem (recommended) or ethers.js v6
- **Framework**: NestJS or Express
- **Database**: SQLite (MVP) / PostgreSQL (Production)
- **Queue**: In-memory (MVP) / Redis + BullMQ (Production)
- **Testing**: Vitest
- **Package Manager**: npm or pnpm

### Data Sources (Lending Rates)

| Protocol | RPC Address | Subgraph URL | Status |
|----------|-------------|--------------|--------|
| **Aave V3** | TBD (Base Pool) | `https://graph.base.org/subgraphs/name/...` | ⚠️Perlu verifikasi |
| **Morpho** | TBD (Morpho Core) | `https://graph.base.org/subgraphs/name/...` | ⚠️Perlu verifikasi |
| **Moonwell** | TBD (Moonwell Pool) | `https://graph.moonwell.fi/subgraphs/name/...` | ⚠️Perlu verifikasi |

> **Note**: Subgraph availability perlu diverifikasi terlebih dahulu sebelum implementation. Voir [The Graph Explorer](https://thegraph.com/explorer) atau [Base Gateway](https://gateway.thegraph.com) untuk cek ketersediaan.

---

# 3. APPROACH OVERVIEW

## Architecture Strategy: Modular & Event-Driven

### Why This Approach?
1. **Separation of Concerns**: Monitoring, orchestration, dan execution dipisah untuk security dan maintainability
2. **Gas Efficiency**: Smart contract hanya melakukan flashloan execution, tidak ada on-chain pricing calculation
3. **Risk Management**: Position Manager bertindak sebagai gatekeeper sebelum eksekusi
4. **Multi-Protocol Support**: Adapter pattern untuk fleksibilitas flashloan provider

### Alternative Considered
- **On-chain only**: Tidak feasible karena gas untuk pricing calculation terlalu mahal
- **Fully centralized**: Menaikkan smart contract risk dan trust assumption

---

# 4. IMPLEMENTATION STEPS

> **Note**: Urutan phases dapat disesuaikan. Disarankan memulai dengan **Phase 2 (Research)** untuk memverifikasi ketersediaan data sources sebelum membangun monitoring bot.

## PHASE 1: Smart Contract Development (Solidity)

### Step 1.1: Flashloan Receiver Base Contract
**Goal**: Membuat kontrak dasar yang dapat menerima flashloan dari multiple providers

**Method**:
- Implement `IFlashLoanReceiver` interface
- Support Aave V3 `flashLoan()` dan `flashLoanSimple()`
- Support Morpho flashloan calls
- Include callback validation

**Reference**: `contracts/FlashloanArbitrage.sol`

```solidity
// Core interface
interface IFlashLoanReceiver {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
```

### Step 1.2: Arbitrage Executor Contract
**Goal**: Implement logic untuk lending protocol arbitrage execution setelah menerima flashloan

**Method**:
- Decode params untuk route informasi (supply protocol, borrow protocol, token)
- Supply ke protocol dengan highest APY
- Borrow dari protocol dengan lowest APR
- Swap borrowed token ke original token (jika diperlukan)
- Repay flashloan + fee
- Withdraw dari supply protocol
- Calculate profit

**Reference**: `contracts/ArbitrageExecutor.sol`

### Step 1.3: Multi-Protocol Adapter
**Goal**: Support berbagai flashloan providers dengan unified interface

**Method**:
- Create adapter pattern untuk Aave (Spark), Morpho, Moonwell
- Factory pattern untuk deploy temporary contracts jika diperlukan
- Emergency withdraw functionality

**Reference**: `contracts/adapters/AaveAdapter.sol`, `contracts/adapters/MorphoAdapter.sol`, `contracts/adapters/MoonwellAdapter.sol`

---

## PHASE 2: Research & Discovery (Pre-Implementation)

### Step 2.0: Verify Subgraph Availability
**Goal**: Memastikan subgraph tersedia untuk protokol target di Base network

**Method**:
1. Cek The Graph Explorer untuk Base network
2. Verifikasi Aave V3, Morpho, Moonwell subgraph existence
3. Test query response dan data availability
4. Document subgraph endpoints yang valid
5. Jika subgraph tidak tersedia, fallback ke RPC-only

**Reference**: 
- The Graph Explorer: https://thegraph.com/explorer
- Base Gateway: https://gateway.thegraph.com
- DefiLlama Subgraphs: https://defillama.com/subgraphs

**Deliverables**:
- Valid subgraph URLs per protocol
- Fallback strategy (RPC-only) jika subgraph tidak tersedia

---

## PHASE 3: Off-Chain Monitoring Bot (Node.js + TypeScript)

### Step 3.1: Lending Rate Monitor Service
**Goal**: Mendeteksi yield spread antar lending protokol secara real-time

**Method**:
- Monitor supply rate dan borrow rate dari Aave, Morpho, Moonwell
- Gunakan kombinasi **Direct RPC** (real-time) dan **Subgraph** (historical/efficient)
- Calculate spread: (supply APY - borrow APR)
- Trigger arbitrage signal jika spread > flashloan fee + gas
- Monitor liquidity availability

#### Data Sources Strategy

| Layer | Source | Use Case |
|-------|--------|----------|
| **Initial Scan** | DefiLlama API | Cek kasar ada opportunity atau tidak |
| **Validation** | Direct RPC (viem) | Validasi real-time sebelum eksekusi |
| **Historical** | Subgraph (The Graph) | Analysis dan backup |

#### Direct RPC Implementation (viem)
```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({
  chain: base,
  transport: http('https://mainnet.base.org'),
});

// Get rate from Aave V3 Pool
async function getAaveRates(tokenAddress: string) {
  const [supplyRate, borrowRate] = await client.readContract({
    address: AAVE_POOL_V3_ADDRESS,
    abi: AAVE_POOL_ABI,
    functionName: 'getReserveData',
    args: [tokenAddress],
  });
  
  return {
    supplyApy: supplyRate.currentSupplyRate,
    borrowApr: borrowRate.currentVariableBorrowRate,
    liquidity: supplyRate.availableLiquidity,
  };
}
```

#### Subgraph Implementation
```typescript
// Query Aave V3 rates dari Base Subgraph
const AAVE_SUBGRAPH_URL = 'https://graph.base.org/subgraphs/name/aave-v3-base';

async function getRatesFromSubgraph() {
  const query = `
    query GetLendingRates {
      reserves(where: { symbol_in: ["USDC", "DAI", "USDT"] }) {
        symbol
        supplyAPY
        variableBorrowAPY
        totalLiquidity
      }
    }
  `;
  
  const response = await fetch(AAVE_SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  
  return response.json();
}
```

**Reference**: `bot/src/monitor/rate-monitor.ts`

### Step 3.2: Opportunity Filter & Validator
**Goal**: Filter sinyal yang tidak profitable atau terlalu berisiko

**Method**:
- Simulate transaction sebelum execution (using flashbots/protocol RPC)
- Check mempool untuk competitive opportunities
- Validate liquidity sufficiency
- Calculate break-even amount

**Reference**: `bot/src/monitor/opportunity-filter.ts`

---

## PHASE 4: Orchestrator

### Step 4.1: Job Queue & Scheduling
**Goal**: Mengkoordinasikan execution flow dan manage concurrency

**Method**:
- Implement Redis-based job queue
- Priority queue untuk high-value opportunities
- Retry mechanism dengan exponential backoff
- Dead letter queue untuk failed jobs

**Reference**: `bot/src/orchestrator/job-queue.ts`

### Step 4.2: Transaction Builder
**Goal**: Build raw transactions dengan optimal gas settings

**Method**:
- Encode function calls untuk smart contract
- Set optimal gas limit (estimate + buffer)
- Set maxFeePerGas dan maxPriorityFeePerGas
- Support EIP-1559 transaction type

**Reference**: `bot/src/orchestrator/tx-builder.ts`

---

## PHASE 5: Position Manager

### Step 5.1: Risk Parameters Engine
**Goal**: Define dan enforce risk limits

**Method**:
- Max position size per trade
- Max daily loss limit
- Max concurrent positions
- Per-asset exposure limits

**Reference**: `bot/src/position/risk-engine.ts`

### Step 5.2: PnL Tracker
**Goal**: Track profit/loss dan generate reports

**Method**:
- Record setiap execution dengan timestamp
- Calculate net PnL termasuk gas dan fees
- Dashboard untuk visualization

**Reference**: `bot/src/position/pnl-tracker.ts`

---

## PHASE 6: Gas Optimization

### Step 6.1: Smart Contract Optimization
**Goal**: Minimize gas usage dalam smart contract

**Method**:
- Use `calldata` instead of `memory` untuk read-only parameters
- Batch multiple swaps dalam single transaction
- Use assembly untuk simple calculations
- Optimize variable packing

**Reference**: `contracts/libraries/GasOptimizations.sol`

### Step 6.2: Transaction Gas Strategy
**Goal**: Optimal gas pricing untuk Base network

**Method**:
- Monitor baseFee historis
- Use dynamic pricing algorithm
- Set appropriate tip untuk block inclusion
- Consider bundle transactions

**Reference**: `bot/src/utils/gas-strategy.ts`

---

## PHASE 7: Risk Considerations

### Step 7.1: Smart Contract Security
**Goal**: Mitigate smart contract risks

**Method**:
- Reentrancy guards
- Access control untuk admin functions
- Circuit breakers (pause functionality)
- Timelock untuk critical parameters

**Reference**: `contracts/security/SecurityUtils.sol`

### Step 7.2: Operational Risk Management
**Goal**: Handle operational failures gracefully

**Method**:
- Slippage protection (set min output)
- Deadline enforcement
- Oracle price validation
- Emergency exit procedures

**Reference**: `bot/src/risk/operational-risk.ts`

---

# 5. TESTING AND VALIDATION

## Unit Testing
- **Smart Contracts**: Foundry/Hardhat test untuk setiap function
  - Flashloan callback execution
  - Arbitrage logic correctness
  - Emergency functions
  
- **Bot Components**: Jest/Vitest untuk off-chain logic
  - Rate calculation accuracy
  - Opportunity filtering logic
  - Risk engine enforcement

## Integration Testing
- **Mainnet Fork Testing**: Gunakan Anvil/Foundry mainnet fork
  - Execute flashloan pada testnet dengan real pools
  - Validate end-to-end flow
  
- **Simulation**: Use Tenderly untuk transaction simulation
  - Gas estimation accuracy
  - Profit calculation validation

## Staging & Deployment
- **Testnet Deployment**: Deploy ke Base Sepolia (testnet)
  - Monitor bot behavior dengan fake money
  - Validate monitoring → execution pipeline
  
- **Canary Deployment**: 1% allocation pada mainnet
  - Real execution dengan minimal capital
  - Validate real profit/loss

## Monitoring & Alerting
- **Dashboard**: Grafana + Prometheus
  - Success rate
  - Average profit per trade
  - Gas spent vs profit
  
- **Alerts**: PagerDuty/Discord untuk
  - Failed transactions
  - Abnormal loss patterns
  - Smart contract events

---

## SUCCESS CRITERIA

| Metric | Target |
|--------|--------|
| Flashloan Success Rate | > 95% |
| Average Profit per Trade | > $10 (after gas) |
| Max Drawdown | < 5% daily |
| Gas Efficiency | < 500k gas per tx |
| System Uptime | > 99.5% |
