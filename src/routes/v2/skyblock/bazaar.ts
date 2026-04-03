import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
import { errors } from '../../../utils/errors.js';
import type { BazaarProductData } from '../../../workers/bazaar-tracker.js';

interface BazaarParams {
  itemId: string;
}

interface BulkQuery {
  search?: string;
  category?: string;
  tier?: string;
  item_ids?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

interface MoversQuery {
  range?: '1h' | '24h';
  limit?: number;
}

interface HistoryQuery {
  range?: '1h' | '6h' | '24h' | '7d' | '30d';
}

const NUMERIC_SORT_FIELDS = new Set([
  'instant_buy_price', 'instant_sell_price', 'buy_volume', 'sell_volume',
  'margin', 'margin_percent', 'tax_adjusted_margin',
  'buy_moving_week', 'sell_moving_week', 'buy_orders', 'sell_orders',
]);

const STRING_SORT_FIELDS = new Set(['display_name', 'item_id', 'category']);

interface SnapshotRow {
  item_id: string;
  instant_buy: number;
  instant_sell: number;
  avg_buy: number;
  avg_sell: number;
  buy_volume: number;
  sell_volume: number;
  recorded_at: string;
}

interface HourlyRow {
  item_id: string;
  bucket: string;
  avg_instant_buy: number;
  avg_instant_sell: number;
  avg_buy: number;
  avg_sell: number;
  avg_buy_volume: number;
  avg_sell_volume: number;
}

const RANGE_TO_INTERVAL: Record<string, string> = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

const RANGE_TO_RESOLUTION: Record<string, string> = {
  '1h': '~20s',  // raw snapshots, every Hypixel update
  '6h': '~20s',  // raw snapshots
  '24h': '~20s', // raw snapshots
  '7d': '1h',    // pre-aggregated hourly averages
  '30d': '1h',   // pre-aggregated hourly averages
};

const RANGE_TO_MAX_AGE: Record<string, number> = {
  '1h': 10,    // near-live, raw snapshots
  '6h': 30,    // raw snapshots
  '24h': 60,   // 5-min resolution
  '7d': 3600,  // hourly buckets
  '30d': 3600, // hourly buckets
};

export async function v2BazaarRoute(app: FastifyInstance): Promise<void> {
  // GET /v2/skyblock/bazaar — all products with search, sort, pagination
  app.get<{ Querystring: BulkQuery }>(
    '/v2/skyblock/bazaar',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'List all bazaar products',
        description: 'Returns all bazaar products with processed data, margins, and metadata. Supports text search, category/tier filtering, sorting by any numeric field, and pagination.',
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Text search on item_id and display_name (case-insensitive).' },
            category: { type: 'string', description: 'Filter by item category (e.g. enchantment, essence, sword).' },
            tier: { type: 'string', description: 'Filter by item tier/rarity (e.g. COMMON, RARE, LEGENDARY).' },
            item_ids: { type: 'string', description: 'Comma-separated list of item IDs to fetch (e.g. DIAMOND,GOLD_INGOT). Overrides search/category/tier filters.' },
            sort: { type: 'string', description: 'Sort field. Numeric: instant_buy_price, instant_sell_price, buy_volume, sell_volume, margin, margin_percent, tax_adjusted_margin, buy_moving_week, sell_moving_week, buy_orders, sell_orders. String: display_name, item_id, category.' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'desc', description: 'Sort order.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Results per page (max 200).' },
            offset: { type: 'integer', minimum: 0, default: 0, description: 'Number of results to skip.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          400: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: BulkQuery }>, reply: FastifyReply) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<BazaarProductData[]>('warm', 'bazaar-products', 'latest');
      if (!cached) {
        throw errors.validation('Bazaar data not available yet. The bazaar tracker may not have run.');
      }

      let products = cached.data;
      const { search, category, tier, item_ids, sort, order, limit: rawLimit, offset: rawOffset } = request.query;

      // Filter by explicit item IDs (overrides search/category/tier)
      if (item_ids) {
        const ids = new Set(item_ids.split(',').map((id) => id.trim().toUpperCase()));
        products = products.filter((p) => ids.has(p.item_id));
      }

      // Filter by text search
      if (search) {
        const needle = search.toLowerCase();
        products = products.filter((p) =>
          p.item_id.toLowerCase().includes(needle) ||
          (p.display_name?.toLowerCase().includes(needle) ?? false),
        );
      }

      // Filter by category (case-insensitive)
      if (category) {
        const cat = category.toLowerCase();
        products = products.filter((p) => p.category === cat);
      }

      // Filter by tier (case-insensitive, tiers are UPPER in Hypixel data)
      if (tier) {
        const t = tier.toUpperCase();
        products = products.filter((p) => p.tier === t);
      }

      const totalFiltered = products.length;

      // Sort
      if (sort && NUMERIC_SORT_FIELDS.has(sort)) {
        const dir = order === 'asc' ? 1 : -1;
        const field = sort as keyof BazaarProductData;
        products = [...products].sort((a, b) => {
          const av = a[field] as number;
          const bv = b[field] as number;
          return (av - bv) * dir;
        });
      } else if (sort && STRING_SORT_FIELDS.has(sort)) {
        const dir = order === 'asc' ? 1 : -1;
        const field = sort as keyof BazaarProductData;
        products = [...products].sort((a, b) => {
          const av = (a[field] as string | null) ?? '';
          const bv = (b[field] as string | null) ?? '';
          return av.localeCompare(bv) * dir;
        });
      }

      // Paginate
      const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);
      const offset = Math.max(rawOffset ?? 0, 0);
      const page = products.slice(offset, offset + limit);

      void reply.header('Cache-Control', 'public, max-age=10');
      return {
        success: true,
        data: {
          products: page,
          total: totalFiltered,
          limit,
          offset,
        },
        meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/bazaar/categories — list available categories with product counts
  app.get(
    '/v2/skyblock/bazaar/categories',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'List bazaar categories',
        description: 'Returns all available bazaar categories with the number of products in each. Use these values for the category filter on the bulk endpoint.',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<BazaarProductData[]>('warm', 'bazaar-products', 'latest');
      if (!cached) {
        throw errors.validation('Bazaar data not available yet.');
      }

      const counts = new Map<string, number>();
      for (const p of cached.data) {
        counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      }

      const categories = Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      void reply.header('Cache-Control', 'public, max-age=60');
      return {
        success: true,
        data: { categories },
        meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/bazaar/movers — top price gainers and losers
  app.get<{ Querystring: MoversQuery }>(
    '/v2/skyblock/bazaar/movers',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get top bazaar price movers',
        description: 'Returns the top items with the biggest price increases (gainers) and decreases (losers) over the specified time range.',
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['1h', '24h'], default: '1h', description: 'Time range to compare against.' },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Number of gainers/losers to return (max 50).' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: MoversQuery }>, reply: FastifyReply) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const range = request.query.range ?? '1h';
      const limit = Math.min(Math.max(request.query.limit ?? 10, 1), 50);

      // Get current prices from cache
      const currentCache = await cacheGet<BazaarProductData[]>('warm', 'bazaar-products', 'latest');
      if (!currentCache) {
        throw errors.validation('Bazaar data not available yet.');
      }
      const currentPrices = new Map(currentCache.data.map((p) => [p.item_id, p]));

      // Get historical prices from DB snapshots
      const interval = range === '1h' ? '1 hour' : '24 hours';
      const cutoff = new Date(Date.now() - parseDuration(interval)).toISOString();

      // Fetch the earliest snapshot per item within the range window (the "before" price)
      // Use raw snapshots for 1h, hourly aggregates for 24h
      let historicalPrices: Map<string, { instant_buy: number; instant_sell: number }>;

      if (range === '24h') {
        // Use the oldest hourly bucket in range
        let rows: HourlyRow[];
        try {
          rows = await postgrestSelect<HourlyRow>({
            table: 'bazaar_hourly',
            query: { bucket: `gte.${cutoff}` },
            order: 'bucket.asc',
            select: 'item_id,bucket,avg_instant_buy,avg_instant_sell',
            limit: 2000, // ~1200 items, grab oldest bucket
          });
        } catch {
          rows = [];
        }
        historicalPrices = new Map();
        for (const row of rows) {
          if (!historicalPrices.has(row.item_id)) {
            historicalPrices.set(row.item_id, { instant_buy: row.avg_instant_buy, instant_sell: row.avg_instant_sell });
          }
        }
      } else {
        // Use oldest raw snapshot in range
        let rows: SnapshotRow[];
        try {
          rows = await postgrestSelect<SnapshotRow>({
            table: 'bazaar_snapshots',
            query: { recorded_at: `gte.${cutoff}` },
            order: 'recorded_at.asc',
            select: 'item_id,instant_buy,instant_sell,recorded_at',
            limit: 2000,
          });
        } catch {
          rows = [];
        }
        historicalPrices = new Map();
        for (const row of rows) {
          if (!historicalPrices.has(row.item_id)) {
            historicalPrices.set(row.item_id, { instant_buy: row.instant_buy, instant_sell: row.instant_sell });
          }
        }
      }

      // Compute price changes
      interface Mover {
        item_id: string;
        display_name: string | null;
        current_instant_buy: number;
        previous_instant_buy: number;
        change: number;
        change_percent: number;
      }

      const movers: Mover[] = [];
      for (const [itemId, current] of currentPrices) {
        const previous = historicalPrices.get(itemId);
        if (!previous || previous.instant_buy <= 0 || current.instant_buy_price <= 0) continue;

        const change = current.instant_buy_price - previous.instant_buy;
        const changePct = Math.round((change / previous.instant_buy) * 10000) / 100;

        movers.push({
          item_id: itemId,
          display_name: current.display_name,
          current_instant_buy: current.instant_buy_price,
          previous_instant_buy: previous.instant_buy,
          change: Math.round(change * 100) / 100,
          change_percent: changePct,
        });
      }

      // Sort for gainers (biggest positive change %) and losers (biggest negative change %)
      const gainers = [...movers]
        .filter((m) => m.change_percent > 0)
        .sort((a, b) => b.change_percent - a.change_percent)
        .slice(0, limit);

      const losers = [...movers]
        .filter((m) => m.change_percent < 0)
        .sort((a, b) => a.change_percent - b.change_percent)
        .slice(0, limit);

      const maxAge = range === '1h' ? 30 : 300;
      void reply.header('Cache-Control', `public, max-age=${maxAge}`);

      return {
        success: true,
        data: { range, gainers, losers },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/bazaar/:itemId — processed bazaar data
  app.get<{ Params: BazaarParams }>(
    '/v2/skyblock/bazaar/:itemId',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get processed bazaar product data',
        description: 'Returns processed bazaar data with instant prices (from order book), weighted averages, and top 10 orders.',
        params: {
          type: 'object',
          required: ['itemId'],
          properties: {
            itemId: { type: 'string', description: 'Hypixel item ID in SCREAMING_SNAKE_CASE.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          400: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams }>, reply: FastifyReply) => {
      const { itemId } = request.params;
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<BazaarProductData>('warm', 'bazaar', itemId);
      if (cached) {
        void reply.header('Cache-Control', 'public, max-age=10');
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No bazaar data available for item ${itemId}. The bazaar tracker may not have run yet.`);
    },
  );

  // GET /v2/skyblock/bazaar/:itemId/history — computed price history
  app.get<{ Params: BazaarParams; Querystring: HistoryQuery }>(
    '/v2/skyblock/bazaar/:itemId/history',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get bazaar price history',
        description: 'Returns historical price snapshots with instant and average prices, plus period summary.',
        params: {
          type: 'object',
          required: ['itemId'],
          properties: {
            itemId: { type: 'string', description: 'Hypixel item ID in SCREAMING_SNAKE_CASE.' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h', description: 'Time range.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams; Querystring: HistoryQuery }>, reply: FastifyReply) => {
      const { itemId } = request.params;
      const range = request.query.range ?? '24h';
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const interval = RANGE_TO_INTERVAL[range] ?? '24 hours';
      const resolution = RANGE_TO_RESOLUTION[range] ?? '5m';
      const cutoff = new Date(Date.now() - parseDuration(interval)).toISOString();

      // Use hourly aggregates for 7d/30d, raw snapshots for shorter ranges
      const useHourly = range === '7d' || range === '30d';

      let datapoints: Array<{
        timestamp: number;
        instant_buy_price: number;
        instant_sell_price: number;
        avg_buy_price: number;
        avg_sell_price: number;
        buy_volume: number;
        sell_volume: number;
      }>;

      if (useHourly) {
        let rows: HourlyRow[];
        try {
          rows = await postgrestSelect<HourlyRow>({
            table: 'bazaar_hourly',
            query: {
              item_id: `eq.${itemId}`,
              bucket: `gte.${cutoff}`,
            },
            order: 'bucket.asc',
            select: 'item_id,bucket,avg_instant_buy,avg_instant_sell,avg_buy,avg_sell,avg_buy_volume,avg_sell_volume',
          });
        } catch {
          rows = [];
        }

        datapoints = rows.map((row) => ({
          timestamp: new Date(row.bucket).getTime(),
          instant_buy_price: row.avg_instant_buy,
          instant_sell_price: row.avg_instant_sell,
          avg_buy_price: row.avg_buy,
          avg_sell_price: row.avg_sell,
          buy_volume: row.avg_buy_volume,
          sell_volume: row.avg_sell_volume,
        }));
      } else {
        let rows: SnapshotRow[];
        try {
          rows = await postgrestSelect<SnapshotRow>({
            table: 'bazaar_snapshots',
            query: {
              item_id: `eq.${itemId}`,
              recorded_at: `gte.${cutoff}`,
            },
            order: 'recorded_at.asc',
            select: 'item_id,instant_buy,instant_sell,avg_buy,avg_sell,buy_volume,sell_volume,recorded_at',
          });
        } catch {
          rows = [];
        }

        datapoints = rows.map((row) => ({
          timestamp: new Date(row.recorded_at).getTime(),
          instant_buy_price: row.instant_buy,
          instant_sell_price: row.instant_sell,
          avg_buy_price: row.avg_buy,
          avg_sell_price: row.avg_sell,
          buy_volume: row.buy_volume,
          sell_volume: row.sell_volume,
        }));
      }

      const count = datapoints.length;
      const summary = count > 0 ? {
        avg_instant_buy: Math.round((datapoints.reduce((s, d) => s + d.instant_buy_price, 0) / count) * 100) / 100,
        avg_instant_sell: Math.round((datapoints.reduce((s, d) => s + d.instant_sell_price, 0) / count) * 100) / 100,
        avg_buy: Math.round((datapoints.reduce((s, d) => s + d.avg_buy_price, 0) / count) * 100) / 100,
        avg_sell: Math.round((datapoints.reduce((s, d) => s + d.avg_sell_price, 0) / count) * 100) / 100,
      } : null;

      // ETag based on item, range, and latest datapoint timestamp
      const lastTs = count > 0 ? datapoints[count - 1]!.timestamp : 0;
      const etag = `"bz-${itemId}-${range}-${lastTs}"`;

      // Check If-None-Match — return 304 if data hasn't changed
      const ifNoneMatch = request.headers['if-none-match'];
      if (ifNoneMatch === etag) {
        void reply.code(304);
        return;
      }

      const maxAge = RANGE_TO_MAX_AGE[range] ?? 60;
      void reply.header('Cache-Control', `public, max-age=${maxAge}`);
      void reply.header('ETag', etag);

      return {
        success: true,
        data: { item_id: itemId, range, resolution, count, summary, datapoints },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

function parseDuration(interval: string): number {
  const match = interval.match(/^(\d+)\s+(hour|hours|day|days)$/);
  if (!match) return 86400000;
  const [, numStr, unit] = match;
  const num = parseInt(numStr ?? '1');
  if (unit === 'hour' || unit === 'hours') return num * 3600000;
  if (unit === 'day' || unit === 'days') return num * 86400000;
  return 86400000;
}
