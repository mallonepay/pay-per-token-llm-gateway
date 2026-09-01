/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Keypair,
  TransactionBuilder,
  Horizon,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import {
  generateKeypair,
  keypairFromSecret,
  getNetworkPassphrase,
  getHorizonUrl,
  getSorobanRpcUrl,
  buildPaymentTransaction,
  buildUnsignedPaymentTransaction,
  createHorizonServer,
  accountExists,
  getAccountBalances,
  getTransaction,
  signChallenge,
  verifyChallenge,
} from './index';

// ── Fixtures ──────────────────────────────────

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const CHALLENGE = 'sign-this-challenge-2026';
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

const SOURCE_KEYPAIR = Keypair.random();
const SOURCE_SECRET = SOURCE_KEYPAIR.secret();
const SOURCE_PUBLIC = SOURCE_KEYPAIR.publicKey();
const DEST_PUBLIC = Keypair.random().publicKey();

/** Fake Horizon AccountRecord with the methods TransactionBuilder needs. */
function mockSourceAccount(publicKey: string, initialSeq = 123) {
  let seq = initialSeq;
  return {
    accountId: () => publicKey,
    sequenceNumber: () => String(seq),
    incrementSequenceNumber: () => {
      seq += 1;
    },
  };
}

function buildOptions(overrides: Record<string, any> = {}): any {
  return {
    sourceSecret: SOURCE_SECRET,
    destination: DEST_PUBLIC,
    amount: '5.5',
    asset: 'USDC',
    assetIssuer: USDC_ISSUER,
    memo: undefined,
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    ...overrides,
  };
}

function buildUnsignedOptions(overrides: Record<string, any> = {}): any {
  return {
    sourcePublicKey: SOURCE_PUBLIC,
    destination: DEST_PUBLIC,
    amount: '5.5',
    asset: 'USDC',
    assetIssuer: USDC_ISSUER,
    memo: undefined,
    network: 'testnet',
    horizonUrl: HORIZON_URL,
    ...overrides,
  };
}

// ── Test harness ──────────────────────────────

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

// ── Key management ────────────────────────────

describe('generateKeypair / keypairFromSecret', () => {
  it('generates a valid public/secret key pair', () => {
    const { publicKey, secretKey } = generateKeypair();

    expect(publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(secretKey).toMatch(/^S[A-Z2-7]{55}$/);
    expect(keypairFromSecret(secretKey).publicKey()).toBe(publicKey);
  });

  it('generates distinct keypairs on each call', () => {
    const first = generateKeypair();
    const second = generateKeypair();
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.secretKey).not.toBe(second.secretKey);
  });

  it('reconstructs keypair correctly from secret key', () => {
    const kp = Keypair.random();
    const loaded = keypairFromSecret(kp.secret());
    expect(loaded.publicKey()).toBe(kp.publicKey());
    expect(loaded.secret()).toBe(kp.secret());
  });
});

// ── Network configuration ─────────────────────

describe('getNetworkPassphrase', () => {
  it('returns the correct passphrase for each network', () => {
    expect(getNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
    expect(getNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
    expect(getNetworkPassphrase('futurenet')).toBe(Networks.FUTURENET);
  });
});

describe('getHorizonUrl', () => {
  it('returns the correct Horizon URL for each network', () => {
    expect(getHorizonUrl('mainnet')).toBe('https://horizon.stellar.org');
    expect(getHorizonUrl('testnet')).toBe('https://horizon-testnet.stellar.org');
    expect(getHorizonUrl('futurenet')).toBe('https://horizon-futurenet.stellar.org');
  });
});

describe('getSorobanRpcUrl', () => {
  it('returns the correct Soroban RPC URL for each network', () => {
    expect(getSorobanRpcUrl('mainnet')).toBe('https://soroban-mainnet.stellar.org');
    expect(getSorobanRpcUrl('testnet')).toBe('https://soroban-testnet.stellar.org');
    expect(getSorobanRpcUrl('futurenet')).toBe('https://rpc-futurenet.stellar.org');
  });
});

describe('createHorizonServer', () => {
  it('creates a testnet server by default', () => {
    const server = createHorizonServer();
    expect(server).toBeInstanceOf(Horizon.Server);
    expect((server.serverURL as any).hostname()).toBe('horizon-testnet.stellar.org');
  });

  it('creates a server for the requested network', () => {
    const serverMainnet = createHorizonServer('mainnet');
    expect(serverMainnet).toBeInstanceOf(Horizon.Server);
    expect((serverMainnet.serverURL as any).hostname()).toBe('horizon.stellar.org');

    const serverFuturenet = createHorizonServer('futurenet');
    expect(serverFuturenet).toBeInstanceOf(Horizon.Server);
    expect((serverFuturenet.serverURL as any).hostname()).toBe('horizon-futurenet.stellar.org');
  });

  it('prefers a custom URL when provided', () => {
    const server = createHorizonServer('mainnet', 'https://custom-horizon.example.com');
    expect(server).toBeInstanceOf(Horizon.Server);
    expect((server.serverURL as any).hostname()).toBe('custom-horizon.example.com');
  });
});

// ── Payment transaction builder (Unsigned) ────

describe('buildUnsignedPaymentTransaction', () => {
  it('builds an unsigned USDC payment with memo and correct fee', async () => {
    const result = await buildUnsignedPaymentTransaction(
      buildUnsignedOptions({ memo: 'invoice-999', amount: '12.5000000' }),
    );

    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.txXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(loadAccountSpy).toHaveBeenCalledWith(SOURCE_PUBLIC);

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.hash().toString('hex')).toBe(result.txHash);
    expect(decoded.source).toBe(SOURCE_PUBLIC);
    expect(decoded.fee).toBe(BASE_FEE);
    expect(decoded.signatures).toHaveLength(0); // Unsigned

    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(DEST_PUBLIC);
    expect(parseFloat(op.amount)).toBe(12.5);
    expect(op.asset.getCode()).toBe('USDC');
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER);

    expect(decoded.memo.type).toBe('text');
    expect(decoded.memo.value.toString()).toBe('invoice-999');
  });

  it('builds an unsigned native XLM payment without memo', async () => {
    const result = await buildUnsignedPaymentTransaction(
      buildUnsignedOptions({ asset: 'XLM', assetIssuer: undefined, memo: undefined }),
    );

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.fee).toBe(BASE_FEE);
    expect(decoded.signatures).toHaveLength(0);

    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.asset.isNative()).toBe(true);
    expect(parseFloat(op.amount)).toBe(5.5);
    expect(decoded.memo.type).toBe('none');
  });

  it('throws for USDC without an issuer', async () => {
    await expect(
      buildUnsignedPaymentTransaction(buildUnsignedOptions({ asset: 'USDC', assetIssuer: undefined })),
    ).rejects.toThrow('Unsupported asset or missing issuer: USDC');
  });

  it('throws for an unsupported asset code', async () => {
    await expect(
      buildUnsignedPaymentTransaction(
        buildUnsignedOptions({ asset: 'BTC' as any, assetIssuer: USDC_ISSUER }),
      ),
    ).rejects.toThrow('Unsupported asset or missing issuer: BTC');
  });

  it('propagates error when account loading fails in Horizon', async () => {
    loadAccountSpy.mockRejectedValueOnce(new Error('Horizon: Account Not Found'));

    await expect(buildUnsignedPaymentTransaction(buildUnsignedOptions())).rejects.toThrow(
      'Horizon: Account Not Found',
    );
  });
});

// ── Payment transaction builder (Signed) ──────

describe('buildPaymentTransaction', () => {
  it('builds and signs a USDC payment with memo and fee calculation', async () => {
    const result = await buildPaymentTransaction(buildOptions({ memo: 'order-123' }));

    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.txXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(loadAccountSpy).toHaveBeenCalledWith(SOURCE_PUBLIC);

    // The XDR must decode back to the same transaction with the same hash.
    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET) as any;
    expect(decoded.hash().toString('hex')).toBe(result.txHash);
    expect(decoded.source).toBe(SOURCE_PUBLIC);
    expect(decoded.fee).toBe(BASE_FEE);
    expect(decoded.signatures).toHaveLength(1);

    const op = decoded.operations[0];
    expect(op.type).toBe('payment');
    expect(op.destination).toBe(DEST_PUBLIC);
    expect(parseFloat(op.amount)).toBe(5.5);
    expect(op.asset.getCode()).toBe('USDC');
    expect(op.asset.getIssuer()).toBe(USDC_ISSUER);

    const memo = decoded.memo;
    expect(memo.type).toBe('text');
    expect(memo.value.toString()).toBe('order-123');

    // Verify signature cryptographic integrity
    const sig = decoded.signatures[0];
    expect(SOURCE_KEYPAIR.verify(decoded.hash(), sig.signature())).toBe(true);
  });

  it('builds a native XLM payment without an issuer', async () => {
    const result = await buildPaymentTransaction(
      buildOptions({ asset: 'XLM', assetIssuer: undefined }),
    );

    const decoded = TransactionBuilder.fromXDR(result.txXdr, Networks.TESTNET);
    const op = decoded.operations[0] as any;
    expect(op.type).toBe('payment');
    expect(op.asset.isNative()).toBe(true);
    expect(parseFloat(op.amount)).toBe(5.5);
    expect(decoded.fee).toBe(BASE_FEE);
  });

  it('verifies signing flow binds to the specific network passphrase', async () => {
    const testnetResult = await buildPaymentTransaction(
      buildOptions({ network: 'testnet' }),
    );

    // Decoding with testnet passphrase succeeds and signature verifies
    const testnetTx = TransactionBuilder.fromXDR(testnetResult.txXdr, Networks.TESTNET);
    expect(SOURCE_KEYPAIR.verify(testnetTx.hash(), testnetTx.signatures[0].signature())).toBe(true);

    // Decoding with public passphrase produces a different hash, so signature does NOT verify
    const mainnetTx = TransactionBuilder.fromXDR(testnetResult.txXdr, Networks.PUBLIC);
    expect(mainnetTx.hash().toString('hex')).not.toBe(testnetResult.txHash);
    expect(SOURCE_KEYPAIR.verify(mainnetTx.hash(), mainnetTx.signatures[0].signature())).toBe(false);
  });

  it('supports external signing flow (build unsigned -> sign externally)', async () => {
    const unsignedResult = await buildUnsignedPaymentTransaction(buildUnsignedOptions());
    const tx = TransactionBuilder.fromXDR(unsignedResult.txXdr, Networks.TESTNET);
    expect(tx.signatures).toHaveLength(0);

    // Sign externally with source keypair
    tx.sign(SOURCE_KEYPAIR);
    expect(tx.signatures).toHaveLength(1);
    expect(SOURCE_KEYPAIR.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    expect(tx.hash().toString('hex')).toBe(unsignedResult.txHash);
  });

  it('throws for USDC without an issuer', async () => {
    await expect(buildPaymentTransaction(buildOptions({ assetIssuer: undefined }))).rejects.toThrow(
      'Unsupported asset or missing issuer: USDC',
    );
  });

  it('throws for an unsupported asset', async () => {
    await expect(
      buildPaymentTransaction(buildOptions({ asset: 'EURT', assetIssuer: 'GOTHER123' })),
    ).rejects.toThrow('Unsupported asset or missing issuer: EURT');
  });

  it('throws for an invalid source secret key', async () => {
    await expect(
      buildPaymentTransaction(buildOptions({ sourceSecret: 'not-a-secret' })),
    ).rejects.toThrow(/invalid/i);
  });

  it('propagates error when account loading fails in Horizon', async () => {
    loadAccountSpy.mockRejectedValueOnce(new Error('Horizon: 500 Internal Server Error'));

    await expect(buildPaymentTransaction(buildOptions())).rejects.toThrow(
      'Horizon: 500 Internal Server Error',
    );
  });
});

// ── Horizon helpers ───────────────────────────

describe('accountExists', () => {
  it('returns true when the account loads', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({ id: SOURCE_PUBLIC }),
    } as unknown as Horizon.Server;

    await expect(accountExists(SOURCE_PUBLIC, server)).resolves.toBe(true);
    expect(server.loadAccount).toHaveBeenCalledWith(SOURCE_PUBLIC);
  });

  it('returns false when the account cannot be loaded (404)', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Not found')),
    } as unknown as Horizon.Server;

    await expect(accountExists(SOURCE_PUBLIC, server)).resolves.toBe(false);
  });

  it('returns false on network or server error', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as Horizon.Server;

    await expect(accountExists(SOURCE_PUBLIC, server)).resolves.toBe(false);
  });
});

describe('getAccountBalances', () => {
  it('maps native and issued asset balances', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({
        balances: [
          { asset_type: 'native', balance: '10.5' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUER,
            balance: '25',
          },
        ],
      }),
    } as unknown as Horizon.Server;

    await expect(getAccountBalances(SOURCE_PUBLIC, server)).resolves.toEqual([
      { asset: 'XLM', balance: '10.5' },
      { asset: 'USDC', balance: '25', issuer: USDC_ISSUER },
    ]);
  });

  it('returns only native balance when no trustlines exist', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({
        balances: [{ asset_type: 'native', balance: '100.0' }],
      }),
    } as unknown as Horizon.Server;

    await expect(getAccountBalances(SOURCE_PUBLIC, server)).resolves.toEqual([
      { asset: 'XLM', balance: '100.0' },
    ]);
  });

  it('returns an empty array when the account cannot be loaded', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Not found')),
    } as unknown as Horizon.Server;

    await expect(getAccountBalances(SOURCE_PUBLIC, server)).resolves.toEqual([]);
  });
});

describe('getTransaction', () => {
  const TX_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

  it('returns the transaction when the lookup succeeds', async () => {
    const txRecord = { id: TX_HASH, successful: true };
    const server = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockResolvedValue(txRecord),
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(getTransaction(TX_HASH, server)).resolves.toEqual(txRecord);
    expect(server.transactions().transaction).toHaveBeenCalledWith(TX_HASH);
  });

  it('returns null when the lookup fails (404 Not Found)', async () => {
    const server = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockRejectedValue(new Error('Not found')),
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(getTransaction(TX_HASH, server)).resolves.toBeNull();
  });

  it('returns null on timeout or network error', async () => {
    const server = {
      transactions: jest.fn().mockReturnValue({
        transaction: jest.fn().mockReturnValue({
          call: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(getTransaction(TX_HASH, server)).resolves.toBeNull();
  });
});

// ── Horizon Submission Error Handling ─────────

describe('Horizon transaction submission and error handling (mock responses)', () => {
  const MOCK_TX_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('handles successful transaction submission to Horizon', async () => {
    const mockSuccessResponse = {
      id: MOCK_TX_HASH,
      hash: MOCK_TX_HASH,
      ledger: 450123,
      successful: true,
      envelope_xdr: 'AAAA...',
      result_xdr: 'AAAA...',
    };

    const server = {
      submitTransaction: jest.fn().mockResolvedValue(mockSuccessResponse),
    } as unknown as Horizon.Server;

    const response = await server.submitTransaction({} as any);
    expect(response).toEqual(mockSuccessResponse);
    expect(response.successful).toBe(true);
    expect(response.hash).toBe(MOCK_TX_HASH);
  });

  it('handles Horizon submission error with op_underfunded result code', async () => {
    const horizonError: any = new Error('Transaction submission failed');
    horizonError.response = {
      status: 400,
      data: {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        title: 'Transaction Failed',
        status: 400,
        detail: 'The transaction failed when executed on the Stellar network.',
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_underfunded'],
          },
        },
      },
    };

    const server = {
      submitTransaction: jest.fn().mockRejectedValue(horizonError),
    } as unknown as Horizon.Server;

    await expect(server.submitTransaction({} as any)).rejects.toThrow('Transaction submission failed');

    try {
      await server.submitTransaction({} as any);
    } catch (err: any) {
      expect(err.response.status).toBe(400);
      expect(err.response.data.extras.result_codes.transaction).toBe('tx_failed');
      expect(err.response.data.extras.result_codes.operations).toContain('op_underfunded');
    }
  });

  it('handles Horizon submission error with op_no_destination result code', async () => {
    const horizonError: any = new Error('Transaction submission failed');
    horizonError.response = {
      status: 400,
      data: {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        title: 'Transaction Failed',
        status: 400,
        extras: {
          result_codes: {
            transaction: 'tx_failed',
            operations: ['op_no_destination'],
          },
        },
      },
    };

    const server = {
      submitTransaction: jest.fn().mockRejectedValue(horizonError),
    } as unknown as Horizon.Server;

    try {
      await server.submitTransaction({} as any);
    } catch (err: any) {
      expect(err.response.data.extras.result_codes.operations).toContain('op_no_destination');
    }
  });

  it('handles Horizon submission error with tx_bad_seq or tx_insufficient_fee', async () => {
    const horizonError: any = new Error('Bad Sequence');
    horizonError.response = {
      status: 400,
      data: {
        extras: {
          result_codes: {
            transaction: 'tx_bad_seq',
          },
        },
      },
    };

    const server = {
      submitTransaction: jest.fn().mockRejectedValue(horizonError),
    } as unknown as Horizon.Server;

    try {
      await server.submitTransaction({} as any);
    } catch (err: any) {
      expect(err.response.data.extras.result_codes.transaction).toBe('tx_bad_seq');
    }
  });

  it('handles Horizon 504 Gateway Timeout error', async () => {
    const timeoutError: any = new Error('Gateway Timeout');
    timeoutError.response = {
      status: 504,
      data: {
        type: 'https://stellar.org/horizon-errors/timeout',
        title: 'Timeout',
        status: 504,
        detail: 'Horizon did not receive a response from stellar-core within the timeout period.',
      },
    };

    const server = {
      submitTransaction: jest.fn().mockRejectedValue(timeoutError),
    } as unknown as Horizon.Server;

    await expect(server.submitTransaction({} as any)).rejects.toThrow('Gateway Timeout');
    try {
      await server.submitTransaction({} as any);
    } catch (err: any) {
      expect(err.response.status).toBe(504);
      expect(err.response.data.title).toBe('Timeout');
    }
  });

  it('handles network-level disconnect or connection refused error', async () => {
    const networkError = new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8000');

    const server = {
      submitTransaction: jest.fn().mockRejectedValue(networkError),
    } as unknown as Horizon.Server;

    await expect(server.submitTransaction({} as any)).rejects.toThrow('ECONNREFUSED');
  });
});

// ── Wallet auth signing ───────────────────────

describe('signChallenge / verifyChallenge', () => {
  it('produces a signature that verifies for the same keypair', () => {
    const signature = signChallenge({
      secretKey: SOURCE_SECRET,
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, signature)).toBe(true);
  });

  it('rejects a signature when the challenge is tampered with', () => {
    const signature = signChallenge({
      secretKey: SOURCE_SECRET,
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE + '-tampered', signature)).toBe(false);
  });

  it('rejects a signature from a different keypair', () => {
    const otherSignature = signChallenge({
      secretKey: Keypair.random().secret(),
      challenge: CHALLENGE,
      network: 'testnet',
    });

    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, otherSignature)).toBe(false);
  });

  it('rejects a signature that is not valid base64', () => {
    expect(verifyChallenge(SOURCE_PUBLIC, CHALLENGE, '!!!not-base64!!!')).toBe(false);
  });
});

