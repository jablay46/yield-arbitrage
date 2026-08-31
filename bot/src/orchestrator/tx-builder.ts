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
   * Simulate first — a revert here means the tx would fail on-chain,
   * so it never reaches the mempool. The simulation's request is forwarded
   * directly to writeContract (instead of rebuilding the call) so the
   * encoded args are guaranteed to match what was validated. Gas is sized
   * via estimateContractGas with the configured buffer rather than reusing
   * the simulation's gas estimate.
   *
   * The `as never` casts sidestep viem's per-functionName arg inference for
   * the union of openLoop/closeLoop; the `as const` call objects are exact.
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

  private async waitAndCheck(hash: Hex): Promise<SentTx> {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted on-chain: ${hash}`);
    }
    this.logger.info(`Tx confirmed in block ${receipt.blockNumber}`);
    return { hash, gasUsed: receipt.gasUsed };
  }
}
