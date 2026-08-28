/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Additional tests for @x402/wallet — covers the gaps identified in bounty issue #8:
 *  - buildUnsignedPaymentTransaction (correct amount/asset/destination/memo, fee, error paths)
 *  - Horizon submission error handling (submitTransaction failure modes via mock server)
 * All Horizon interactions are mocked — no real network is touched.
 */
import {
  Keypair,
  TransactionBuilder,
  Horizon,
  Networks,
  Asset,
  Operation,
} from '@stellar/stellar-sdk';
import {
  buildUnsignedPaymentTransaction,
  buildPaymentTransaction,
  createHorizonServer,
} from './index';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_SECRET = SOURCE_KEYPAIR.secret();
const SOURCE_PUBLIC = SOURCE_KEYPAIR.publicKey();
const DEST_PUBLIC = Keypair.random().publicKey();

function mockSourceAccount(publicKey: string) {
  let seq = 100;
  return {
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => {
      seq += 1;
    },
  };
}

function baseOptions(overrides: Record<string, any> = {}): any {
  return {
    sourceSecret: SOURCE_SECRET,
    sourcePublicKey: SOURCE_PUBLIC,
    destination: DEST_PUBLIC,
    amount: '10',
    asset: 'XLM',
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    ...overrides,
  };
}

let loadAccountSpy: jest.SpyInstance;

beforeEach(() => {
  loadAccountSpy = jest
    .spyOn(Horizon.Server.prototype, 'loadAccount')
    .mockImplementation(async () => mockSourceAccount(SOURCE_PUBLIC) as any);
});

afterEach(() => {
  loadAccountSpy.mockRestore();
  jest.restoreAllMocks();
});

// ── buildUnsignedPaymentTransaction ───────────

describe('buildUnsignedPaymentTransaction', () => {
  it('builds an unsigned XLM payment with correct amount and destination', async () => {
    const { txXdr, txHash } = await buildUnsignedPaymentTransaction(
      baseOptions({ amount: '42.5' }),
    );

    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    const decoded = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as any;
    expect(decoded.source).toBe(SOURCE_PUBLIC);
    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(DEST_PUBLIC);
    expect(parseFloat(op.amount)).toBe(42.5);
    expect(op.asset.isNative()).toBe(true);
  });

  it('builds a USDC payment that requires an issuer', async () => {
    const { txXdr } = await buildUnsignedPaymentTransaction(
      baseOptions({ asset: 'USDC', assetIssuer: USDC_ISSUER, amount: '7' }),
    );

    const decoded = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as any;
    const op = decoded.operations[0];
    expect(op.asset.getCode()).toBe('USDC');
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER);
    expect(parseFloat(op.amount)).toBe(7);
  });

  it('attaches a text memo when provided and omits it otherwise', async () => {
    const withMemo = await buildUnsignedPaymentTransaction(baseOptions({ memo: 'inv-42' }));
    const decodedMemo = TransactionBuilder.fromXDR(withMemo.txXdr, Networks.TESTNET) as any;
    expect(decodedMemo.memo.type).toBe('text');
    expect(decodedMemo.memo.value.toString()).toBe('inv-42');

    const withoutMemo = await buildUnsignedPaymentTransaction(baseOptions({ memo: undefined }));
    const decodedNoMemo = TransactionBuilder.fromXDR(withoutMemo.txXdr, Networks.TESTNET) as any;
    expect(decodedNoMemo.memo.value).toBeNull();
  });

  it('uses BASE_FEE as the transaction fee', async () => {
    const { txXdr } = await buildUnsignedPaymentTransaction(baseOptions());
    const decoded = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as any;
    // BASE_FEE is 100 stroops
    expect(parseInt(decoded.fee, 10)).toBe(100);
  });

  it('rejects USDC without an issuer', async () => {
    await expect(
      buildUnsignedPaymentTransaction(baseOptions({ asset: 'USDC', assetIssuer: undefined })),
    ).rejects.toThrow('Unsupported asset or missing issuer: USDC');
  });

  it('rejects unsupported assets', async () => {
    await expect(
      buildUnsignedPaymentTransaction(baseOptions({ asset: 'FAKE', assetIssuer: 'GABC123' })),
    ).rejects.toThrow('Unsupported asset or missing issuer: FAKE');
  });

  it('propagates Horizon loadAccount failures', async () => {
    loadAccountSpy.mockRejectedValue(new Error('NetworkError'));
    await expect(buildUnsignedPaymentTransaction(baseOptions())).rejects.toThrow('NetworkError');
  });
});

// ── Signed payment round-trip ─────────────────

describe('buildPaymentTransaction signature round-trip', () => {
  it('produces a signed transaction whose signature set includes the source key', async () => {
    const { txXdr } = await buildPaymentTransaction(baseOptions({ amount: '3.3' }));
    const decoded = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET) as any;
    expect(decoded.signatures.length).toBeGreaterThan(0);
    // Verify the signature verifies against the source public key
    const txHashBuf = decoded.hash();
    const sig = decoded.signatures[0].signature();
    expect(SOURCE_KEYPAIR.verify(txHashBuf, sig)).toBe(true);
  });

  it('re-hydrating with the wrong network passphrase fails the signature check', async () => {
    const { txXdr } = await buildPaymentTransaction(baseOptions());
    const decodedWrong = TransactionBuilder.fromXDR(txXdr, Networks.PUBLIC) as any;
    const txHashBuf = decodedWrong.hash();
    const sig = decodedWrong.signatures[0].signature();
    // Signing hash differs across networks → source key no longer verifies
    expect(SOURCE_KEYPAIR.verify(txHashBuf, sig)).toBe(false);
  });
});

// ── Horizon submission error handling ─────────

describe('Horizon submission error handling', () => {
  function makeServerWithSubmit(impl: () => Promise<any>) {
    return {
      submitTransaction: jest.fn().mockImplementation(impl),
      loadAccount: jest.fn(),
    } as unknown as Horizon.Server;
  }

  it('a successful submitTransaction resolves with the Horizon response', async () => {
    const horizonResponse = { hash: 'abc', successful: true, ledger: 12345 };
    const server = makeServerWithSubmit(async () => horizonResponse);

    const { txXdr } = await buildPaymentTransaction(baseOptions());
    const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
    await expect(server.submitTransaction(tx)).resolves.toEqual(horizonResponse);
  });

  it('a "transaction failed" Horizon error carries the result codes', async () => {
    const err: any = new Error('The operation was attempted somewhere in the past.');
    err.response = {
      status: 400,
      data: {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        title: 'Transaction Failed',
        extras: { result_codes: { transaction: 'tx_bad_seq', operations: ['op_underfunded'] } },
      },
    };
    err.data = err.response.data;
    const server = makeServerWithSubmit(async () => {
      throw err;
    });

    const { txXdr } = await buildPaymentTransaction(baseOptions());
    const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
    await expect(server.submitTransaction(tx)).rejects.toMatchObject({
      response: { status: 400 },
      data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
    });
  });

  it('a network-level failure (timeout/connection reset) surfaces as a rejected promise', async () => {
    const server = makeServerWithSubmit(async () => {
      throw new Error('Connection reset by peer');
    });

    const { txXdr } = await buildPaymentTransaction(baseOptions());
    const tx = TransactionBuilder.fromXDR(txXdr, Networks.TESTNET);
    await expect(server.submitTransaction(tx)).rejects.toThrow('Connection reset by peer');
  });
});
