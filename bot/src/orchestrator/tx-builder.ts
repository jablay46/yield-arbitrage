import { Account, Address, Hex } from 'viem';
import { base } from 'viem/chains';
import { encodeFunctionData } from 'viem';
import { BasePublicClient, BaseWalletClient } from '../client-types';
import { loopingExecutorAbi } from '../abis';
import { GasStrategy, GasFees } from '../utils/gas-strategy';
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

/** An encoded contract call ready to be (re)submitted as a raw transaction. */
interface EncodedTx {
  to: Address;
  data: Hex;
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
  /** Highest nonce we have committed to the mempool (avoids reusing nonces). */
  private inflightNonce: bigint | undefined;
  /** How long (ms) to wait for a receipt before replacing the tx with higher fees. */
  private readonly pendingTimeoutMs = 60_000;
  /** Replacement fee bump, as a fraction of the original maxFeePerGas (e.g. 50n = +50%). */
  private readonly rbfBumpBps = 50n;

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
   * Simulate, build, and send a keeperDeleverage transaction. This is the
   * emergency unwind path: callable by anyone once the on-chain health factor
   * is below the contract's critical threshold, and — unlike closeLoop — it
   * remains callable while the executor is paused, so a fail-closed pause
   * cannot strand a critical position.
   * @param req - Close parameters (must match the recorded open position)
   * @returns Transaction hash and gas used
   */
  async keeperDeleverage(req: CloseLoopRequest): Promise<SentTx> {
    this.logger.info(`Keeper deleverage on ${req.collateralAsset}`);

    const call = {
      account: this.account,
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'keeperDeleverage',
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
    const gasEstimate = await this.publicClient.estimateContractGas({
      account: this.account,
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
      blockTag: this.usePendingBlock ? 'pending' : undefined,
    } as never);

    const nonce = await this.nextNonce();
    const encoded = await this.encodeCall({
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
      to: token,
    });

    let hash: Hex;
    try {
      hash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: base,
        to: encoded.to,
        data: encoded.data,
        nonce: Number(nonce),
        gas: this.gas.applyGasBuffer(gasEstimate),
        ...fees,
      } as never);
    } catch (err) {
      this.rollbackNonce();
      throw err;
    }
    this.logger.info(`Tx sent: ${hash} (nonce ${nonce})`);
    return this.waitAndCheck(hash, nonce, fees, gasEstimate, encoded);
  }

  /**
   * Set the Aave e-mode category on the executor (e.g. 1 for ETH-correlated
   * assets) so a high-leverage loop can borrow against the higher LT. Only
   * the owner may call setEMode; a failed simulation never reaches the
   * mempool.
   * @param categoryId - Aave e-mode category id (0 disables)
   * @returns Transaction hash and gas used
   */
  async setEMode(categoryId: number): Promise<SentTx> {
    this.logger.info(`Setting e-mode category ${categoryId} on executor`);
    const call = {
      account: this.account,
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'setEMode',
      args: [categoryId],
    } as const;

    return this.simulateAndSend(call as never);
  }

  /**
   * Pause the executor (fail-closed). Used by the bot when the rate feed goes
   * blind in live mode so no further opens/deleverages can act on stale state.
   * @returns Transaction hash and gas used
   */
  async pause(): Promise<SentTx> {
    this.logger.info('Pausing executor');
    const call = {
      account: this.account,
      address: this.executor,
      abi: loopingExecutorAbi,
      functionName: 'pause',
      args: [],
    } as const;
    return this.simulateAndSend(call as never);
  }

  /**
   * Simulate a contract call, estimate gas, and send the transaction.
   * Simulation occurs against the pending block; a revert here means the tx
   * would fail on-chain and it never reaches the mempool. The call is encoded
   * to raw `to`/`data` once so an RBF replacement resubmits the exact same
   * calldata (not a malformed/no-op tx), and a failed submission rolls back the
   * nonce so a gap never stalls subsequent sends.
   * @param call - Contract call object with account, address, abi, function, and args
   * @returns Transaction hash and gas used
   */
  private async simulateAndSend(call: {
    account: Account;
    address: Address;
    abi: typeof loopingExecutorAbi;
    functionName: 'openLoop' | 'closeLoop' | 'keeperDeleverage' | 'setEMode' | 'pause';
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

    const encoded = await this.encodeCall({
      abi: request.abi,
      functionName: request.functionName as never,
      args: (request.args as readonly unknown[]) ?? [],
      to: (request.address as Address) ?? this.executor,
    });

    // Use an explicit nonce so concurrent cycles cannot collide on the same
    // nonce the wallet client would otherwise pick lazily.
    const nonce = await this.nextNonce();

    let hash: Hex;
    try {
      hash = await this.walletClient.sendTransaction({
        account: this.account,
        chain: base,
        to: encoded.to,
        data: encoded.data,
        nonce: Number(nonce),
        gas: this.gas.applyGasBuffer(gasEstimate),
        ...fees,
      } as never);
    } catch (err) {
      this.rollbackNonce();
      throw err;
    }

    this.logger.info(`Tx sent: ${hash} (nonce ${nonce})`);
    return this.waitAndCheck(hash, nonce, fees, gasEstimate, encoded);
  }

  /**
   * Encode a contract call into raw `to`/`data` so it can be (re)submitted as a
   * raw transaction. Retaining the encoded calldata lets an RBF replacement
   * resubmit the identical call instead of a bare ETH transfer.
   */
  private async encodeCall(input: {
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
    to: Address;
  }): Promise<EncodedTx> {
    const data = encodeFunctionData({
      abi: input.abi as never,
      functionName: input.functionName as never,
      args: input.args as never,
    } as never);
    return { to: input.to, data };
  }

  /**
   * Determine the next nonce to use. Uses the tracked in-flight nonce + 1 once
   * we have one, so back-to-back sends don't reuse the wallet client's cached
   * pending count. Falls back to the chain pending transaction count.
   */
  private async nextNonce(): Promise<bigint> {
    if (this.inflightNonce === undefined) {
      const pending = await this.publicClient.getTransactionCount({
        address: this.account.address,
        blockTag: 'pending',
      });
      this.inflightNonce = BigInt(pending);
      return this.inflightNonce;
    }
    this.inflightNonce = this.inflightNonce + 1n;
    return this.inflightNonce;
  }

  /**
   * Roll back the in-flight nonce tracker after a failed submission so the next
   * send reuses the same nonce instead of skipping it and creating a gap that
   * would stall every subsequent transaction until filled.
   */
  private rollbackNonce(): void {
    if (this.inflightNonce !== undefined && this.inflightNonce > 0n) {
      this.inflightNonce = this.inflightNonce - 1n;
    } else {
      this.inflightNonce = undefined;
    }
  }

  /**
   * Wait for a transaction receipt, replacing the tx with higher fees (RBF)
   * if it stays pending longer than the configured timeout. Each replacement
   * gets a fresh confirmation window and re-capped fees so the loop cannot
   * spin on an already-expired deadline or exceed the operator's gas cap.
   * @returns Transaction hash and gas used
   * @throws Error if the transaction reverted on-chain
   */
  private async waitAndCheck(
    hash: Hex,
    nonce: bigint,
    fees: GasFees,
    gasEstimate: bigint,
    encoded: EncodedTx,
  ): Promise<SentTx> {
    let currentHash = hash;
    let currentFees = fees;
    let deadline = Date.now() + this.pendingTimeoutMs;

    // Poll for a receipt, replacing the tx with higher fees if it stays
    // pending past the timeout. waitForTransactionReceipt would block
    // indefinitely, so we race it against the deadline.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Replace the stuck tx with the same nonce and bumped fees (RBF).
        // Renew the confirmation window so the replacement gets its own
        // chance to land rather than re-entering the loop immediately. When
        // the fee cap leaves no room for a bump, no valid replacement exists —
        // keep waiting on the original tx instead of submitting one the node
        // would reject as underpriced.
        const replaced = await this.replaceWithHigherFees(
          currentHash,
          nonce,
          currentFees,
          gasEstimate,
          encoded,
        );
        if (replaced) {
          currentHash = replaced.hash;
          currentFees = replaced.fees;
        }
        deadline = Date.now() + this.pendingTimeoutMs;
        continue;
      }
      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: currentHash,
          timeout: remaining,
          retryCount: 0,
        } as never);
        if (receipt.status !== 'success') {
          throw new Error(`Transaction reverted on-chain: ${currentHash}`);
        }
        this.logger.info(`Tx confirmed in block ${receipt.blockNumber}`);
        return { hash: currentHash, gasUsed: receipt.gasUsed };
      } catch (err) {
        // A timeout surfaces as an error; loop to the deadline check / RBF path.
        if (Date.now() >= deadline) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Replace a pending transaction (same nonce) with a higher-fee version.
   * Bumps maxFeePerGas and priorityFee by the configured fraction, then
   * re-applies the operator's hard gas cap so a replacement can never exceed
   * the stated maximum. The encoded `to`/`data` of the original call is
   * preserved so the replacement resubmits the same contract call.
   * @returns The replacement hash and fees, or null when the original fees are
   *          already at the cap and no higher-fee replacement is possible
   *          (a same-fee resubmission would be rejected as underpriced).
   */
  private async replaceWithHigherFees(
    oldHash: Hex,
    nonce: bigint,
    fees: GasFees,
    gasEstimate: bigint,
    encoded: EncodedTx,
  ): Promise<{ hash: Hex; fees: GasFees } | null> {
    const bump = (v: bigint) => v + (v * this.rbfBumpBps) / 100n;
    const cap = this.gas.maxFeeCap();
    let maxFeePerGas = bump(fees.maxFeePerGas);
    let maxPriorityFeePerGas = bump(fees.maxPriorityFeePerGas);
    // Re-apply the configured hard cap; if the bumped fee already exceeds it,
    // clamp to the cap.
    if (maxFeePerGas > cap) {
      maxFeePerGas = cap;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      maxPriorityFeePerGas = maxFeePerGas;
    }
    if (
      maxFeePerGas <= fees.maxFeePerGas &&
      maxPriorityFeePerGas <= fees.maxPriorityFeePerGas
    ) {
      this.logger.warn(
        `Tx ${oldHash} pending past timeout but fees already at the cap — ` +
          `no valid replacement; waiting for the original tx`,
      );
      return null;
    }
    const newFees: GasFees = { maxFeePerGas, maxPriorityFeePerGas };

    this.logger.warn(
      `Tx ${oldHash} pending past timeout — replacing nonce ${nonce} with higher fees`,
    );
    const newHash = await this.walletClient.sendTransaction({
      account: this.account,
      chain: base,
      to: encoded.to,
      data: encoded.data,
      nonce: Number(nonce),
      ...newFees,
      gas: gasEstimate > 0n ? this.gas.applyGasBuffer(gasEstimate) : undefined,
    } as never);
    this.logger.info(`Replacement tx sent: ${newHash} (nonce ${nonce})`);
    return { hash: newHash, fees: newFees };
  }
}
