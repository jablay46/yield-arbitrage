import { Account, Address, Hex } from 'viem';
import { base } from 'viem/chains';
import { BasePublicClient, BaseWalletClient } from '../client-types';
import { loopingExecutorAbi } from '../abis';
import { GasStrategy } from '../utils/gas-strategy';
import { Logger } from '../utils/logger';

export interface OpenLoopRequest {
  collateralAsset: Address;
  borrowAsset: Address;
  marginAmount: bigint;
  leverage: 2 | 3 | 5;
  minHealthFactor: bigint;
  swapData: Hex;
  minSwapOut: bigint;
}

export interface CloseLoopRequest {
  collateralAsset: Address;
  borrowAsset: Address;
  swapData: Hex;
  minSwapOut: bigint;
}

export interface SentTx {
  hash: Hex;
  gasUsed?: bigint;
}

/**
 * Builds, simulates and sends LoopingExecutor transactions.
 * Every send is simulated first; a failed simulation never hits the mempool.
 */
export class TransactionBuilder {
  private publicClient: BasePublicClient;
  private walletClient: BaseWalletClient;
  private account: Account;
  private executor: Address;
  private gas: GasStrategy;
  private logger: Logger;
  private usePendingBlock: boolean;

  /**
   * Create a new TransactionBuilder instance.
   * @param publicClient - Viem public client for simulation and gas estimation
   * @param walletClient - Viem wallet client for sending transactions
   * @param account - The account that will sign transactions
   * @param executor - The LoopingExecutor contract address
   * @param gas - Gas strategy for pricing transactions
   * @param logger - Logger instance for transaction events
   * @param usePendingBlock - Whether to simulate against pending block (Flashblocks)
   */
  constructor(
    publicClient: BasePublicClient,
    walletClient: BaseWalletClient,
    account: Account,
    executor: Address,
    gas: GasStrategy,
    logger: Logger,
    usePendingBlock = true
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.executor = executor;
    this.gas = gas;
    this.logger = logger;
    this.usePendingBlock = usePendingBlock;
  }

  /**
   * Simulate, build, and send an openLoop transaction to the executor.
   * @param req - Loop parameters including collateral, margin, and leverage
   * @returns Transaction hash and gas used
   */
  async openLoop(req: OpenLoopRequest): Promise<SentTx> {
    this.logger.info(
      `Opening loop: ${req.leverage}x on ${req.collateralAsset}, margin ${req.marginAmount}`
    );

    const call = {
      account: this.account,
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'openLoop',
      args: [
        {
          collateralAsset: req.collateralAsset,
          borrowAsset: req.borrowAsset,
          marginAmount: req.marginAmount,
          leverage: req.leverage,
          minHealthFactor: req.minHealthFactor,
          swapData: req.swapData,
          minSwapOut: req.minSwapOut,
        },
      ],
    } as const;

    return this.simulateAndSend(call);
  }

  /**
   * Simulate, build, and send a closeLoop transaction to the executor.
   * @param req - Close parameters including collateral, borrow asset, and swap data
   * @returns Transaction hash and gas used
   */
  async closeLoop(req: CloseLoopRequest): Promise<SentTx> {
    this.logger.info(`Closing loop on ${req.collateralAsset}`);

    const call = {
      account: this.account,
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'closeLoop',
      args: [
        {
          collateralAsset: req.collateralAsset,
          borrowAsset: req.borrowAsset,
          swapData: req.swapData,
          minSwapOut: req.minSwapOut,
        },
      ],
    } as const;

    return this.simulateAndSend(call);
  }

  /**
   * Approve the executor to spend margin tokens on behalf of the owner.
   * @param token - The ERC20 token address to approve
   * @param amount - The amount to approve
   * @returns Transaction hash and gas used
   */
  async approveMargin(token: Address, amount: bigint): Promise<SentTx> {
    this.logger.info(`Approving ${amount} of ${token} to executor`);
    const fees = await this.gas.getFees();
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: base,
      address: token,
      abi: [
        {
          name: 'approve',
          type: 'function',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      functionName: 'approve',
      args: [this.executor, amount],
      ...fees,
    });
    return this.waitAndCheck(hash);
  }

  /**
   * Simulate a contract call, estimate gas, and send the transaction.
   * Simulation occurs against the pending block; a revert here means the tx
   * would fail on-chain and it never reaches the mempool. The simulation's
   * request is forwarded to writeContract so encoded args match exactly.
   * @param call - Contract call object with account, address, abi, function, and args
   * @returns Transaction hash and gas used
   */
  private async simulateAndSend(call: {
    account: Account;
    address: Address;
    abi: typeof loopingExecutorAbi;
    functionName: 'openLoop' | 'closeLoop';
    args: readonly unknown[];
  }): Promise<SentTx> {
    // Simulate against the "pending" block — on Base that resolves to the
    // latest Flashblock (~200ms), so we validate against the freshest state.
    const { request } = await this.publicClient.simulateContract({
      ...(call as object),
      blockTag: this.usePendingBlock ? 'pending' : undefined,
    } as never);

    const fees = await this.gas.getFees();
    const gasEstimate = await this.publicClient.estimateContractGas({
      ...(call as object),
      account: this.account,
      blockTag: this.usePendingBlock ? 'pending' : undefined,
    } as never);

    const hash = await this.walletClient.writeContract({
      ...request,
      chain: base,
      ...fees,
      gas: this.gas.applyGasBuffer(gasEstimate),
    } as never);

    this.logger.info(`Tx sent: ${hash}`);
    return this.waitAndCheck(hash);
  }

  /**
   * Wait for transaction confirmation and verify it succeeded.
   * @param hash - Transaction hash to wait for
   * @returns Transaction hash and gas used
   * @throws Error if the transaction reverted on-chain
   */
  private async waitAndCheck(hash: Hex): Promise<SentTx> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted on-chain: ${hash}`);
    }
    this.logger.info(`Tx confirmed in block ${receipt.blockNumber}`);
    return { hash, gasUsed: receipt.gasUsed };
  }
}
