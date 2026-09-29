import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletFacade } from '@midnightntwrk/wallet-sdk/facade';

// Stands in for ledger deserialization so the facade sees a known object.
const dappTx = { dapp: true };
vi.mock('@midnight-ntwrk/ledger-v8', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@midnight-ntwrk/ledger-v8')>()),
  Transaction: { deserialize: vi.fn(() => dappTx) },
}));

import {
  balanceTransaction,
  buildTransferTransaction,
  deriveWalletKeys,
  type WalletKeys,
} from '../../../src/sync/operations.js';
import { NIGHT_TOKEN_ID } from '../../../src/types/tokens.js';
import { VERIFIED_PREPROD_ADDRESS, testSeedHex } from '../../helpers/seed.js';

let keys: WalletKeys;
beforeAll(async () => {
  keys = deriveWalletKeys(await testSeedHex());
});

const finalized = { finalized: true };
const nothingToBalance = new Error('No balancing transaction was created. Please check your transaction.');

function facadeWith(methods: Record<string, unknown>) {
  const signRecipe = vi.fn(async (recipe: unknown) => recipe);
  const finalizeRecipe = vi.fn().mockResolvedValue(finalized);
  return {
    facade: { signRecipe, finalizeRecipe, ...methods } as unknown as WalletFacade,
    signRecipe,
    finalizeRecipe,
  };
}

describe('buildTransferTransaction payFees', () => {
  const request = { type: 'unshielded' as const, tokenId: NIGHT_TOKEN_ID, amount: 1n, to: VERIFIED_PREPROD_ADDRESS };

  it.each([
    [undefined, true],
    [false, false],
  ])('forwards payFees %s to the facade as %s', async (payFees, expected) => {
    const transferTransaction = vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION', transaction: {} });
    const { facade } = facadeWith({ transferTransaction });
    await buildTransferTransaction(facade, keys, 'preprod', [request], undefined, undefined, payFees);
    expect(transferTransaction.mock.calls[0]![2]).toEqual({ ttl: expect.any(Date), payFees: expected });
  });
});

describe('balanceTransaction payFees', () => {
  let balanceFinalizedTransaction: ReturnType<typeof vi.fn>;
  let balanceUnboundTransaction: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    balanceFinalizedTransaction = vi.fn().mockResolvedValue({ type: 'FINALIZED_TRANSACTION' });
    balanceUnboundTransaction = vi.fn().mockResolvedValue({ type: 'UNBOUND_TRANSACTION' });
  });

  it.each([
    [true, true, 'all'],
    [true, false, ['shielded', 'unshielded']],
    [false, true, 'all'],
    [false, false, ['shielded', 'unshielded']],
  ])('sealed=%s payFees=%s balances token kinds %j', async (sealed, payFees, kinds) => {
    const { facade } = facadeWith({ balanceFinalizedTransaction, balanceUnboundTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), sealed, payFees)).resolves.toBe(
      finalized,
    );
    const balance = sealed ? balanceFinalizedTransaction : balanceUnboundTransaction;
    expect(balance).toHaveBeenCalledWith(dappTx, expect.anything(), {
      ttl: expect.any(Date),
      tokenKindsToBalance: kinds,
    });
  });

  it('returns a sealed transaction unchanged when only the fee was missing', async () => {
    balanceFinalizedTransaction.mockRejectedValue(nothingToBalance);
    const { facade, finalizeRecipe } = facadeWith({ balanceFinalizedTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), true, false)).resolves.toBe(dappTx);
    expect(finalizeRecipe).not.toHaveBeenCalled();
  });

  it('binds an unsealed transaction without a balancing segment when only the fee was missing', async () => {
    balanceUnboundTransaction.mockRejectedValue(nothingToBalance);
    const { facade, finalizeRecipe } = facadeWith({ balanceUnboundTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), false, false)).resolves.toBe(
      finalized,
    );
    expect(finalizeRecipe).toHaveBeenCalledWith({ type: 'UNBOUND_TRANSACTION', baseTransaction: dappTx });
  });

  it('still surfaces the facade error when the wallet pays fees', async () => {
    balanceFinalizedTransaction.mockRejectedValue(nothingToBalance);
    const { facade } = facadeWith({ balanceFinalizedTransaction });
    await expect(balanceTransaction(facade, keys, 'preprod', new Uint8Array(), true, true)).rejects.toBe(
      nothingToBalance,
    );
  });
});
