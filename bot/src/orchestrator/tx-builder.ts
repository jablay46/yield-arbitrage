import {
  PublicClient,
  WalletClient,
  Account,
  Address,
  Hex,
  encodeFunctionData,
  parseUnits,
} from 'viem';
import { ArbitrageExecutor__factory } from '../typechain-types';
import { ValidatedOpportunity } from './opportunity-filter';

/**
 * Transaction builder configuration
 */
export interface TxBuilderConfig {
  // Contract addresses
  arbitrageExecutorAddress: Address;
  
  // Gas settings
  maxFeePerGasGwei: number;
  maxPriorityFeePerGasGwei: number;
  gasLimitBuffer: number; // percentage
  
  // Execution settings
  nonce?: number;
  ttl?: number; // time to live in seconds
}

/**
 * Built transaction ready for signing
 */
export interface BuiltTransaction {
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  chainId: number;
}

/**
 * Transaction builder
 * Builds transactions for arbitrage execution
 */
export class TransactionBuilder {
  private client: PublicClient;
  private wallet: WalletClient;
  private account: Account;
  private config: TxBuilderConfig;
  
  constructor(
    client: PublicClient,
    wallet: WalletClient,
    account: Account,
    config: Partial<TxBuilderConfig>
  ) {
    this.client = client;
    this.wallet = wallet;
    this.account = account;
    
    this.config = {
      arbitrageExecutorAddress: config.arbitrageExecutorAddress ?? '0x',
      maxFeePerGasGwei: config.maxFeePerGasGwei ?? 50,
      maxPriorityFeePerGasGwei: config.maxPriorityFeePerGasGwei ?? 2,
      gasLimitBuffer: config.gasLimitBuffer ?? 20,
      nonce: config.nonce ?? 0,
      ttl: config.ttl ?? 300, // 5 minutes
    };
  }
  
  /**
   * Build arbitrage execution transaction
   */
  async buildArbitrageTx(
    opportunity: ValidatedOpportunity
  ): Promise<BuiltTransaction> {
    // Get gas price
    const feeData = await this.client.getFeeHistory({
      blockCount: 5,
      rewardPercentiles: [50],
    });
    
    // Calculate max fee per gas
    const baseFee = feeData.baseFeePerGas[feeData.baseFeePerGas.length - 1];
    const priorityFee = parseUnits(
      BigInt(this.config.maxPriorityFeePerGasGwei).toString(),
      'gwei'
    );
    
    const maxPriorityFeePerGas = priorityFee;
    const maxFeePerGas = baseFee + priorityFee;
    
    // Cap at max
    const maxFeeCap = parseUnits(
      BigInt(this.config.maxFeePerGasGwei).toString(),
      'gwei'
    );
    
    const finalMaxFeePerGas = maxFeePerGas > maxFeeCap ? maxFeeCap : maxFeePerGas;
    
    // Estimate gas
    const gasEstimate = await this.estimateGas(opportunity);
    const gasLimit = this.applyGasBuffer(gasEstimate);
    
    // Get nonce
    const nonce = await this.client.getTransactionCount({
      address: this.account.address,
    });
    
    // Get chain ID
    const chainId = (await this.client.getChainId()) as number;
    
    // Encode function data
    const data = this.encodeArbitrageData(opportunity);
    
    return {
      to: this.config.arbitrageExecutorAddress,
      data,
      value: 0n,
      gasLimit,
      maxFeePerGas: finalMaxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId,
    };
  }
  
  /**
   * Encode arbitrage execution data
   */
  private encodeArbitrageData(opportunity: ValidatedOpportunity): Hex {
    // Create the params for the arbitrage
    const params = {
      supplyToken: opportunity.supplyToken as Address,
      borrowToken: opportunity.borrowToken as Address,
      supplyAmount: opportunity.flashloanAmount,
      borrowAmount: opportunity.flashloanAmount,
      flashloanAmount: opportunity.flashloanAmount,
      minProfit: BigInt(Math.floor(opportunity.netProfitUsd * 1e18)),
      path: [opportunity.supplyToken, opportunity.borrowToken, opportunity.supplyToken] as Address[],
    };
    
    // Using ArbitrageExecutor.executeArbitrage(bytes)
    return encodeFunctionData({
      abi: [
        {
          name: 'executeArbitrage',
          type: 'function',
          inputs: [{ name: 'params', type: 'bytes' }],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'executeArbitrage',
      args: [params as any],
    });
  }
  
  /**
   * Estimate gas for transaction
   */
  private async estimateGas(opportunity: ValidatedOpportunity): Promise<bigint> {
    // In production, use callStatic to estimate
    // For now, use configured estimate
    return 500000n;
  }
  
  /**
   * Apply gas buffer to estimate
   */
  private applyGasBuffer(gasEstimate: bigint): bigint {
    const buffer = gasEstimate * BigInt(this.config.gasLimitBuffer) / 100n;
    return gasEstimate + buffer;
  }
  
  /**
   * Sign and send transaction
   */
  async sendTransaction(tx: BuiltTransaction): Promise<Hex> {
    const hash = await this.wallet.sendTransaction({
      account: this.account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
      chain: this.client.chain,
    });
    
    return hash;
  }
  
  /**
   * Wait for transaction receipt
   */
  async waitForTransactionReceipt(hash: Hex): Promise<any> {
    return this.client.waitForTransactionReceipt({ hash });
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<TxBuilderConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }
}

export default TransactionBuilder;
