import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../../src/plugins/auth.js';
import { v2BazaarRoute } from '../../../src/routes/v2/skyblock/bazaar.js';
import { cacheSet } from '../../../src/services/cache-manager.js';
import { AppError } from '../../../src/utils/errors.js';
import { registerSharedSchemas } from '../../../src/schemas/common.js';
import type { BazaarProductData } from '../../../src/workers/bazaar-tracker.js';

let app: FastifyInstance;

const sampleBazaarData: BazaarProductData = {
  item_id: 'TEST_ITEM',
  instant_buy_price: 100.5,
  instant_sell_price: 99.2,
  avg_buy_price: 100.3,
  avg_sell_price: 99.1,
  buy_volume: 50000,
  sell_volume: 48000,
  buy_orders: 150,
  sell_orders: 120,
  buy_moving_week: 1000000,
  sell_moving_week: 950000,
  top_buy_orders: [{ amount: 500, price_per_unit: 99.2, orders: 1 }],
  top_sell_orders: [{ amount: 300, price_per_unit: 100.5, orders: 1 }],
};

beforeAll(async () => {
  process.env['DEV_AUTH_BYPASS'] = 'true';
  app = Fastify();
  registerSharedSchemas(app);
  app.register(authPlugin);
  app.register(v2BazaarRoute);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        success: false,
        error: { code: error.code, message: error.message, status: error.status },
        meta: { timestamp: Date.now() },
      });
    }
    const fastifyError = error as { validation?: unknown; message: string };
    if (fastifyError.validation) {
      return reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: fastifyError.message, status: 400 },
        meta: { timestamp: Date.now() },
      });
    }
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
      meta: { timestamp: Date.now() },
    });
  });

  await app.ready();

  // Seed warm cache with test data
  await cacheSet('warm', 'bazaar', 'TEST_ITEM', sampleBazaarData);
});

afterAll(async () => {
  await app.close();
});

describe('GET /v2/skyblock/bazaar/:itemId', () => {
  it('returns cached bazaar data in success envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/TEST_ITEM',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.item_id).toBe('TEST_ITEM');
    expect(body.data.instant_buy_price).toBe(100.5);
    expect(body.data.instant_sell_price).toBe(99.2);
    expect(body.data.avg_buy_price).toBe(100.3);
    expect(body.meta.cached).toBe(true);
  });

  it('returns error for uncached item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/NONEXISTENT_ITEM',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /v2/skyblock/bazaar/:itemId/history', () => {
  it('returns history structure with empty datapoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/TEST_ITEM/history?range=1h',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.item_id).toBe('TEST_ITEM');
    expect(body.data.range).toBe('1h');
    expect(body.data.resolution).toBe('1m');
    expect(Array.isArray(body.data.datapoints)).toBe(true);
    expect(body.data.count).toBeGreaterThanOrEqual(0);
  });

  it('defaults to 24h range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/TEST_ITEM/history',
    });
    const body = res.json();
    expect(body.data.range).toBe('24h');
    expect(body.data.resolution).toBe('5m');
  });
});
