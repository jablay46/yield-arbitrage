import { describe, expect, it, vi } from 'vitest';
import type { Account, Address, Hex } from 'viem';
import { TransactionBuilder } from '../src/orchestrator/tx-builder';
import { GasFees, GasStrategy } from '../src/utils/gas-strategy';
import { BasePublicClient, BaseWalletClient } from '../src/client-types';
import { Logger } from '../src/utils/logger';

const EXECUTOR = '0x00000000000000000000000000000000000000e1' as Address;
const ENCODED = { to: EXECUTOR, data: '0xdeadbeef' as Hex };

function makeBuilder(cap: bigint) {
  const walletClient = {
    sendTransaction: vi.fn().mockResolvedValue('0xreplacement' as Hex),
  };
  const gas = {
    maxFeeCap: () => cap,
    applyGasBuffer: (e: bigint) => e,
  } as unknown as GasStrategy;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const builder = new TransactionBuilder(
    {} as BasePublicClient,
    walletClient as unknown as BaseWalletClient,
    { address: '0x00000000000000000000000000000000000000a1' } as Account,
    EXECUTOR,
    gas,
    logger,
  );
  const rbf = builder as unknown as {
    replaceWithHigherFees: (
      oldHash: Hex,
      nonce: bigint,
      fees: GasFees,
      gasEstimate: bigint,
      encoded: typeof ENCODED,
    ) => Promise<{ hash: Hex; fees: GasFees } | null>;
  };
  return { rbf, walletClient };
}

describe('TransactionBuilder RBF at the fee cap', () => {
  it('returns null and sends nothing when both fees are already at the cap', async () => {
    const { rbf, walletClient } = makeBuilder(100n);

    const res = await rbf.replaceWithHigherFees(
      '0xstuck' as Hex,
      1n,
      { maxFeePerGas: 100n, maxPriorityFeePerGas: 100n },
      21_000n,
      ENCODED,
    );

    // A same-fee resubmission would be rejected as underpriced — skip it.
    expect(res).toBeNull();
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it('still replaces via a priority-fee bump when only maxFee is at the cap', async () => {
    const { rbf, walletClient } = makeBuilder(100n);

    const res = await rbf.replaceWithHigherFees(
      '0xstuck' as Hex,
      1n,
      { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      21_000n,
      ENCODED,
    );

    // maxFee is clamped at the cap, but the priority fee can still rise —
    // a valid replacement the node will accept.
    expect(res).not.toBeNull();
    expect(res!.fees.maxFeePerGas).toBe(100n);
    expect(res!.fees.maxPriorityFeePerGas).toBe(15n);
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
  });

  it('bumps and resubmits the same calldata when below the cap', async () => {
    const { rbf, walletClient } = makeBuilder(100n);

    const res = await rbf.replaceWithHigherFees(
      '0xstuck' as Hex,
      1n,
      { maxFeePerGas: 50n, maxPriorityFeePerGas: 5n },
      21_000n,
      ENCODED,
    );

    expect(res).not.toBeNull();
    // +50% bump: 50 -> 75, 5 -> 7 (integer math)
    expect(res!.fees.maxFeePerGas).toBe(75n);
    expect(res!.fees.maxPriorityFeePerGas).toBe(7n);
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
    const sent = walletClient.sendTransaction.mock.calls[0][0] as {
      to: Address;
      data: Hex;
      nonce: number;
    };
    expect(sent.to).toBe(ENCODED.to);
    expect(sent.data).toBe(ENCODED.data);
    expect(sent.nonce).toBe(1);
  });

  it('clamps the bump to the cap', async () => {
    const { rbf } = makeBuilder(100n);

    const res = await rbf.replaceWithHigherFees(
      '0xstuck' as Hex,
      1n,
      { maxFeePerGas: 90n, maxPriorityFeePerGas: 9n },
      21_000n,
      ENCODED,
    );

    // 90 * 1.5 = 135 -> clamped to the 100 cap
    expect(res!.fees.maxFeePerGas).toBe(100n);
    expect(res!.fees.maxPriorityFeePerGas).toBe(13n);
  });
});
