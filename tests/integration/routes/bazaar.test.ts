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
  display_name: 'Test Item',
  category: 'sword',
  tier: 'RARE',
  instant_buy_price: 100.5,   // what user pays (cheapest ask)
  instant_sell_price: 99.2,   // what user gets (highest bid)
  avg_buy_price: 100.3,       // avg cost to buy
  avg_sell_price: 99.1,       // avg revenue selling
  buy_volume: 50000,          // supply (ask-side)
  sell_volume: 48000,         // demand (bid-side)
  buy_orders: 150,
  sell_orders: 120,
  buy_moving_week: 1000000,
  sell_moving_week: 950000,
  margin: -1.3,               // sell - buy (negative = unprofitable)
  margin_percent: -1.29,
  tax_adjusted_margin: -2.43,
  top_buy_orders: [{ amount: 300, price_per_unit: 100.5, orders: 1 }],  // asks (user buys from)
  top_sell_orders: [{ amount: 500, price_per_unit: 99.2, orders: 1 }],  // bids (user sells to)
};

const sampleBazaarData2: BazaarProductData = {
  item_id: 'ENCHANTED_DIAMOND',
  display_name: 'Enchanted Diamond',
  category: 'enchanted_material',
  tier: 'UNCOMMON',
  instant_buy_price: 172.5,   // what user pays
  instant_sell_price: 170.0,  // what user gets
  avg_buy_price: 171.8,
  avg_sell_price: 169.5,
  buy_volume: 200000,
  sell_volume: 180000,
  buy_orders: 500,
  sell_orders: 400,
  buy_moving_week: 5000000,
  sell_moving_week: 4800000,
  margin: -2.5,               // sell - buy (negative = unprofitable)
  margin_percent: -1.45,
  tax_adjusted_margin: -4.44,
  top_buy_orders: [{ amount: 800, price_per_unit: 172.5, orders: 2 }],  // asks
  top_sell_orders: [{ amount: 1000, price_per_unit: 170.0, orders: 3 }], // bids
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
  await cacheSet('warm', 'bazaar', 'ENCHANTED_DIAMOND', sampleBazaarData2);
  await cacheSet('warm', 'bazaar-products', 'latest', [sampleBazaarData, sampleBazaarData2]);
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
    expect(body.data.resolution).toBe('~20s');
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
    expect(body.data.resolution).toBe('~20s');
  });
});

describe('GET /v2/skyblock/bazaar', () => {
  it('returns all products with pagination metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(2);
    expect(body.data.products).toHaveLength(2);
    expect(body.data.limit).toBe(50);
    expect(body.data.offset).toBe(0);
  });

  it('includes margin fields on products', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar',
    });
    const body = res.json();
    const product = body.data.products.find((p: BazaarProductData) => p.item_id === 'TEST_ITEM');
    expect(product.margin).toBe(-1.3);
    expect(product.margin_percent).toBe(-1.29);
    expect(product.tax_adjusted_margin).toBe(-2.43);
  });

  it('filters by text search on item_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?search=diamond',
    });
    const body = res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.products[0].item_id).toBe('ENCHANTED_DIAMOND');
  });

  it('filters by text search on display_name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?search=enchanted',
    });
    const body = res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.products[0].display_name).toBe('Enchanted Diamond');
  });

  it('filters by category (case-insensitive)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?category=Sword',
    });
    const body = res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.products[0].item_id).toBe('TEST_ITEM');
  });

  it('filters by tier', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?tier=UNCOMMON',
    });
    const body = res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.products[0].item_id).toBe('ENCHANTED_DIAMOND');
  });

  it('sorts by buy_volume descending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?sort=buy_volume&order=desc',
    });
    const body = res.json();
    expect(body.data.products[0].item_id).toBe('ENCHANTED_DIAMOND');
    expect(body.data.products[1].item_id).toBe('TEST_ITEM');
  });

  it('sorts ascending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?sort=buy_volume&order=asc',
    });
    const body = res.json();
    expect(body.data.products[0].item_id).toBe('TEST_ITEM');
  });

  it('paginates with limit and offset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?limit=1&offset=1',
    });
    const body = res.json();
    expect(body.data.total).toBe(2);
    expect(body.data.products).toHaveLength(1);
    expect(body.data.limit).toBe(1);
    expect(body.data.offset).toBe(1);
  });

  it('combines search and sort', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar?search=item&sort=instant_buy_price&order=desc',
    });
    const body = res.json();
    // Both items match "item" in display_name ("Test Item", "Enchanted Diamond" doesn't match)
    // Only "Test Item" matches
    expect(body.data.total).toBe(1);
  });
});

describe('GET /v2/skyblock/bazaar/categories', () => {
  it('returns category list with counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/categories',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.categories)).toBe(true);
    expect(body.data.categories.length).toBe(2); // sword + enchanted_material
    const sword = body.data.categories.find((c: { name: string }) => c.name === 'sword');
    expect(sword).toBeDefined();
    expect(sword.count).toBe(1);
  });
});

describe('GET /v2/skyblock/bazaar/movers', () => {
  it('returns gainers and losers arrays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/movers',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.range).toBe('1h');
    expect(Array.isArray(body.data.gainers)).toBe(true);
    expect(Array.isArray(body.data.losers)).toBe(true);
  });

  it('accepts range parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/skyblock/bazaar/movers?range=24h',
    });
    const body = res.json();
    expect(body.data.range).toBe('24h');
  });
});
