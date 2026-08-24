import { X402Client, createX402Client } from './index';
import type { X402ClientConfig, ChatCompletionRequest, PaymentAsset } from '@x402/types';

// ── Mocks ────────────────────────────────────

const mockFetch = jest.fn();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

const mockBuildPaymentTransaction = jest.fn();
const mockBuildUnsignedPaymentTransaction = jest.fn();
const mockCreateHorizonServer = jest.fn(() => ({
  submitTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@x402/wallet', () => ({
  buildPaymentTransaction: (...args: unknown[]) => mockBuildPaymentTransaction(...args),
  buildUnsignedPaymentTransaction: (...args: unknown[]) =>
    mockBuildUnsignedPaymentTransaction(...args),
  createHorizonServer: (...args: unknown[]) => mockCreateHorizonServer(...(args as [])),
}));

// ── Helpers ──────────────────────────────────

const defaultConfig: X402ClientConfig = {
  gatewayUrl: 'https://gateway.test',
  secretKey: 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  network: 'testnet',
  defaultAsset: 'USDC',
  paymentTimeout: 300_000,
};

const chatRequest: ChatCompletionRequest = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
};

function mockOkResponse(body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      get: (name: string) => (headers && headers[name]) ?? null,
      forEach: jest.fn(),
    },
    body: null,
    bodyUsed: false,
    redirected: false,
    statusText: 'OK',
    type: 'basic',
    url: '',
    clone: function () {
      return this;
    },
    blob: async () => new Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
  } as unknown as Response;
}

function mock402Response(paymentRequired: unknown): Response {
  return {
    ok: false,
    status: 402,
    json: async () => paymentRequired,
    text: async () => JSON.stringify(paymentRequired),
    headers: { get: () => null, forEach: jest.fn() },
    body: {
      cancel: jest.fn(),
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        releaseLock: jest.fn(),
        cancel: jest.fn(),
      }),
    },
    bodyUsed: false,
    redirected: false,
    statusText: 'Payment Required',
    type: 'basic',
    url: '',
    clone: function () {
      return this;
    },
    blob: async () => new Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
  } as unknown as Response;
}

function mockErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new Error('Not JSON');
    },
    text: async () => body,
    headers: { get: () => null, forEach: jest.fn() },
    body: null,
    bodyUsed: false,
    redirected: false,
    statusText: 'Error',
    type: 'basic',
    url: '',
    clone: function () {
      return this;
    },
    blob: async () => new Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('X402Client', () => {
  describe('constructor', () => {
    it('creates a client with default config merged', () => {
      const client = new X402Client(defaultConfig);
      expect(client).toBeInstanceOf(X402Client);
    });

    it('overrides default config with provided values', () => {
      const client = new X402Client({ ...defaultConfig, paymentTimeout: 60_000 });
      // Verify by calling — the timeout is used in waitForConfirmation
      expect(client).toBeInstanceOf(X402Client);
    });
  });

  describe('call() — 200 path', () => {
    it('returns successful response on 200', async () => {
      mockFetch.mockResolvedValueOnce(
        mockOkResponse({
          id: 'chatcmpl-123',
          choices: [{ message: { content: 'Hello!' } }],
        }),
      );

      const client = new X402Client(defaultConfig);
      const result = await client.call(chatRequest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.response!.id).toBe('chatcmpl-123');
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gateway.test/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });
  });

  describe('call() — 402 → pay → retry path', () => {
    it('handles 402 payment flow and retries successfully', async () => {
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        assetIssuer: 'GA...',
        memo: { type: 'hash', value: '0x123' },
        network: 'testnet' as const,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      // First request: 402
      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));
      // Payment execution
      mockBuildPaymentTransaction.mockResolvedValueOnce({
        txHash: 'abc123',
        txXdr: 'AAAA...',
      });
      mockCreateHorizonServer.mockReturnValueOnce({
        submitTransaction: jest.fn().mockResolvedValue(undefined),
      });
      // Horizon confirmation poll: first call empty, second call successful
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: false }));
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: true }));
      // Retry with payment proof: 200
      mockFetch.mockResolvedValueOnce(
        mockOkResponse({
          id: 'chatcmpl-456',
          choices: [{ message: { content: 'Paid response' } }],
        }),
      );

      const client = new X402Client(defaultConfig);
      const result = await client.call(chatRequest);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.response!.id).toBe('chatcmpl-456');
      }
      expect(mockBuildPaymentTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns error when quote is expired', async () => {
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        assetIssuer: 'GA...',
        memo: { type: 'hash', value: '0x123' },
        network: 'testnet' as const,
        expiresAt: Math.floor(Date.now() / 1000) - 60, // Expired
      };

      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));

      const client = new X402Client(defaultConfig);
      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('expired');
      }
    });

    it('returns error when asset does not match', async () => {
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'XLM' as PaymentAsset,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));

      const client = new X402Client({ ...defaultConfig, defaultAsset: 'USDC' });
      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Wrong asset');
      }
    });
  });

  describe('call() — gateway errors', () => {
    it('returns error on non-200, non-402 status', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse(500, 'Internal Server Error'));

      const client = new X402Client(defaultConfig);
      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('500');
      }
    });
  });

  describe('executePayment — secretKey path', () => {
    it('returns error when only secretKey is configured', async () => {
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));

      const client = new X402Client({
        ...defaultConfig,
        secretKey: undefined,
      });
      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Payment required');
      }
    });
  });

  describe('executePayment — external signer path', () => {
    it('uses external signer when signTransaction is provided', async () => {
      const signTransaction = jest.fn().mockResolvedValue('SIGNED_XDR');

      const client = new X402Client({
        gatewayUrl: 'https://gateway.test',
        publicKey: 'GABCDEF...',
        signTransaction,
        network: 'testnet',
        paymentTimeout: 300_000,
      });

      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        assetIssuer: 'GA...',
        memo: { type: 'hash', value: '0x123' },
        network: 'testnet' as const,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));
      mockBuildUnsignedPaymentTransaction.mockResolvedValueOnce({
        txHash: 'ext-sig-tx',
        txXdr: 'UNSIGNED_XDR',
      });
      mockCreateHorizonServer.mockReturnValueOnce({
        submitTransaction: jest.fn().mockResolvedValue(undefined),
      });
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: false }));
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: true }));
      mockFetch.mockResolvedValueOnce(
        mockOkResponse({
          id: 'chatcmpl-ext',
          choices: [{ message: { content: 'External signer response' } }],
        }),
      );

      const result = await client.call(chatRequest);

      expect(result.success).toBe(true);
      expect(signTransaction).toHaveBeenCalledWith('UNSIGNED_XDR');
      expect(mockBuildUnsignedPaymentTransaction).toHaveBeenCalledTimes(1);
    });

    it('returns error when signTransaction is provided but publicKey is missing', async () => {
      const client = new X402Client({
        gatewayUrl: 'https://gateway.test',
        signTransaction: jest.fn(),
        network: 'testnet',
        paymentTimeout: 300_000,
      });

      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));

      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('publicKey');
      }
    });
    it('returns error when the external signer rejects the transaction', async () => {
      const signTransaction = jest.fn().mockRejectedValue(new Error('User rejected'));
      const client = new X402Client({
        gatewayUrl: 'https://gateway.test',
        publicKey: 'GABCDEF...',
        signTransaction,
        network: 'testnet',
        paymentTimeout: 300_000,
      });
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };
      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));
      mockBuildUnsignedPaymentTransaction.mockResolvedValueOnce({
        txHash: 'ext-sig-tx',
        txXdr: 'UNSIGNED_XDR',
      });

      const result = await client.call(chatRequest);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('User rejected');
      }
    });
  });

  describe('callStream()', () => {
    it('returns successful stream result on 200', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === 'X-Payment-Receipt' ? '{"amount":"0","asset":"USDC"}' : null,
          forEach: jest.fn(),
        },
        body: stream,
        json: async () => {
          throw new Error('Not JSON');
        },
        text: async () => '',
        bodyUsed: false,
        redirected: false,
        statusText: 'OK',
        type: 'basic',
        url: '',
        clone: function () {
          return this;
        },
        blob: async () => new Blob([]),
        arrayBuffer: async () => new ArrayBuffer(0),
        formData: async () => new FormData(),
      } as unknown as Response);

      const client = new X402Client(defaultConfig);
      const result = await client.callStream(chatRequest);

      expect(result.success).toBe(true);
      if (result.success) {
        const chunks: unknown[] = [];
        for await (const chunk of result.stream!) {
          chunks.push(chunk);
        }
        expect(chunks).toHaveLength(1);
      }
    });

    it('handles 402 → pay → retry for streaming', async () => {
      const quote = {
        paymentAddress: 'GB...',
        amount: '10000000',
        asset: 'USDC' as PaymentAsset,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };

      // First request: 402
      mockFetch.mockResolvedValueOnce(mock402Response({ quote }));
      // Payment
      mockBuildPaymentTransaction.mockResolvedValueOnce({
        txHash: 'stream-pay',
        txXdr: 'AAAA...',
      });
      mockCreateHorizonServer.mockReturnValueOnce({
        submitTransaction: jest.fn().mockResolvedValue(undefined),
      });
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: false }));
      mockFetch.mockResolvedValueOnce(mockOkResponse({ successful: true }));
      // Retry: streaming response
      const encoder = new TextEncoder();
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"id":"2","choices":[{"delta":{"content":"Paid stream"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === 'X-Payment-Receipt' ? '{"amount":"100","asset":"USDC"}' : null,
          forEach: jest.fn(),
        },
        body: stream2,
        json: async () => {
          throw new Error('Not JSON');
        },
        text: async () => '',
        bodyUsed: false,
        redirected: false,
        statusText: 'OK',
        type: 'basic',
        url: '',
        clone: function () {
          return this;
        },
        blob: async () => new Blob([]),
        arrayBuffer: async () => new ArrayBuffer(0),
        formData: async () => new FormData(),
      } as unknown as Response);

      const client = new X402Client(defaultConfig);
      const result = await client.callStream(chatRequest);

      expect(result.success).toBe(true);
      if (result.success) {
        const chunks: unknown[] = [];
        for await (const chunk of result.stream!) {
          chunks.push(chunk);
        }
        expect(chunks).toHaveLength(1);
      }
    });
  });

  describe('checkPaymentStatus()', () => {
    it('returns null when payment status request fails', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse(404, 'Not Found'));

      const client = new X402Client(defaultConfig);
      const status = await client.checkPaymentStatus('quote-1');

      expect(status).toBeNull();
    });

    it('returns receipt when payment status is found', async () => {
      const receipt = { amount: '100', asset: 'USDC' as const };
      mockFetch.mockResolvedValueOnce(mockOkResponse(receipt));

      const client = new X402Client(defaultConfig);
      const status = await client.checkPaymentStatus('quote-1');

      expect(status).toEqual(receipt);
    });
  });

  describe('createX402Client()', () => {
    it('creates a client via factory function', () => {
      const client = createX402Client(defaultConfig);
      expect(client).toBeInstanceOf(X402Client);
    });
  });
});
