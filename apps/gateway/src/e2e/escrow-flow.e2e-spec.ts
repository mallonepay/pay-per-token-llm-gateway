/* eslint-disable @typescript-eslint/no-explicit-any */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';

jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

let mockPaymentStore: Record<string, any>[] = [];

function resetMockStore() {
  mockPaymentStore = [];
}

const ESCROW_USER = 'GB4YJON6574K74SGHSKHPMBJDJPLBPYN4HPGGN2J5RFKMSNFSWLBYFRL';
const PROVIDER_WALLET = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

const routeRegistry: Record<string, any> = {
  'gpt-4': {
    id: 'escrow-route-001',
    providerId: 'escrow-provider-001',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.mock-llm.example.com/v1/chat/completions',
    model: 'gpt-4',
    pricingModel: 'flat',
    flatPrice: '1000000',
    perTokenPrice: null,
    acceptedAssets: ['USDC'],
    rateLimit: 10,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  'gpt-4-per-token': {
    id: 'escrow-route-002',
    providerId: 'escrow-provider-001',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.mock-llm.example.com/v1/chat/completions',
    model: 'gpt-4-per-token',
    pricingModel: 'per_token',
    flatPrice: null,
    perTokenPrice: '50',
    acceptedAssets: ['USDC'],
    rateLimit: 10,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findUnique: jest.fn().mockImplementation(() =>
        Promise.resolve({
          id: 'escrow-provider-001',
          walletAddress: PROVIDER_WALLET,
          active: true,
        }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    route: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        const entry = routeRegistry[where?.model];
        if (!entry || where?.active !== true) return Promise.resolve(null);
        const candidates: string[] = where?.path?.in ?? (where?.path != null ? [where.path] : []);
        if (candidates.length > 0 && !candidates.includes(entry.path)) return Promise.resolve(null);
        return Promise.resolve({ ...entry });
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    payment: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        const record = {
          id: `pay-${Date.now()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockPaymentStore.push(record);
        return Promise.resolve(record);
      }),
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.quoteId)
          return Promise.resolve(mockPaymentStore.find((p) => p.quoteId === where.quoteId) || null);
        if (where?.txHash)
          return Promise.resolve(mockPaymentStore.find((p) => p.txHash === where.txHash) || null);
        return Promise.resolve(null);
      }),
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockPaymentStore)),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let updated = 0;
        mockPaymentStore = mockPaymentStore.map((p) => {
          const matches =
            p.quoteId === where.quoteId && (where.txHash === null || where.txHash === undefined);
          if (matches) {
            updated++;
            return { ...p, ...data };
          }
          return p;
        });
        return Promise.resolve({ count: updated });
      }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
    },
    analyticsEvent: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0n }, _avg: { responseTime: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  },
  Prisma: {},
}));

const mockPrisma = jest.requireMock('@x402/database').prisma as any;

jest.mock('@x402/notifications', () => ({
  dispatcher: {
    dispatch: jest.fn().mockResolvedValue(['email']),
  },
  WebhookNotificationHandler: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue(true),
  })),
}));

jest.mock('ioredis', () => ({
  default: jest.fn().mockImplementation(() => ({
    eval: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    connect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
  })),
  Redis: jest.fn().mockImplementation(() => ({
    eval: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    connect: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
  })),
}));

// Mock the escrow contract client so tests do not hit Soroban RPC.
const mockGetEscrowBalance = jest.fn();
const mockSettleEscrow = jest.fn().mockResolvedValue(undefined);

jest.mock('../modules/x402/escrow-client', () => ({
  getEscrowBalance: (...args: any[]) => mockGetEscrowBalance(...args),
  settleEscrow: (...args: any[]) => mockSettleEscrow(...args),
}));

function createLLMFetch() {
  return jest.fn().mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('mock-llm')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'chatcmpl-escrow-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello from escrow flow!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 300, total_tokens: 500 },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('x402 Gateway E2E — Escrow Flow', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ESCROW_SETTLEMENT_ENABLED = 'true';
    process.env.CREDIT_ESCROW_CONTRACT = 'CDUMMYESCROWCONTRACTID';
    process.env.CONTRACT_ADMIN_SECRET = 'SDUMMYADMINSECRET';

    global.fetch = createLLMFetch() as any;
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('REDIS')
      .useValue({
        eval: jest.fn().mockResolvedValue(1),
        exists: jest.fn().mockResolvedValue(0),
        set: jest.fn().mockResolvedValue('OK'),
        on: jest.fn(),
        connect: jest.fn(),
        ping: jest.fn().mockResolvedValue('PONG'),
      })
      .overrideProvider('PRISMA')
      .useValue(mockPrisma)
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ESCROW_SETTLEMENT_ENABLED;
    delete process.env.CREDIT_ESCROW_CONTRACT;
    delete process.env.CONTRACT_ADMIN_SECRET;
  });

  beforeEach(() => {
    resetMockStore();
    jest.clearAllMocks();
    mockGetEscrowBalance.mockReset();
    mockSettleEscrow.mockClear();
    mockSettleEscrow.mockResolvedValue(undefined);
    global.fetch = createLLMFetch() as any;
  });

  it('forwards request when X-Escrow-User balance covers flat-rate quote', async () => {
    mockGetEscrowBalance.mockResolvedValue('2000000'); // > 1,000,000 flat price

    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/completions')
      .set('X-Escrow-User', ESCROW_USER)
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'Escrow flat' }] })
      .expect(200);

    expect(res.body.choices[0].message.content).toContain('escrow flow');
    expect(mockGetEscrowBalance).toHaveBeenCalledWith(
      expect.objectContaining({ user: ESCROW_USER }),
    );
  });

  it('returns 402 when X-Escrow-User balance is insufficient', async () => {
    mockGetEscrowBalance.mockResolvedValue('100'); // < 1,000,000 flat price

    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/completions')
      .set('X-Escrow-User', ESCROW_USER)
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'Escrow poor' }] })
      .expect(402);

    expect(res.body.status).toBe(402);
    expect(res.body.message).toMatch(/insufficient/i);
  });

  it('forwards per-token request and records actual cost when escrow balance is sufficient', async () => {
    // per-token deposit = 50 × 4096 = 204800
    mockGetEscrowBalance.mockResolvedValue('500000');

    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/completions')
      .set('X-Escrow-User', ESCROW_USER)
      .send({ model: 'gpt-4-per-token', messages: [{ role: 'user', content: 'Escrow PT' }] })
      .expect(200);

    expect(res.headers['x-actual-cost']).toBeDefined();
    expect(res.headers['x-tokens-used']).toBe('500');
    const receipt = JSON.parse(res.headers['x-payment-receipt']);
    expect(receipt.payerAddress).toBe(ESCROW_USER);
    expect(receipt.status).toBe('confirmed');
  });

  it('falls back to 402 when no payment or escrow header is provided', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/completions')
      .send({ model: 'gpt-4', messages: [{ role: 'user', content: 'No pay' }] })
      .expect(402);

    expect(res.body.status).toBe(402);
    expect(res.body.quote).toBeDefined();
    expect(mockGetEscrowBalance).not.toHaveBeenCalled();
  });
});
