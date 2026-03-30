import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
import { errors } from '../../../utils/errors.js';
import type { BazaarProductData } from '../../../workers/bazaar-tracker.js';

interface BazaarParams {
  itemId: string;
}

interface HistoryQuery {
  range?: '1h' | '6h' | '24h' | '7d' | '30d';
}

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
  '1h': '1m',
  '6h': '1m',
  '24h': '5m',
  '7d': '1h',
  '30d': '1h',
};

const RANGE_TO_MAX_AGE: Record<string, number> = {
  '1h': 10,    // near-live, 1-min resolution
  '6h': 30,    // 1-min resolution
  '24h': 60,   // 5-min resolution
  '7d': 3600,  // hourly buckets
  '30d': 3600, // hourly buckets
};

export async function v2BazaarRoute(app: FastifyInstance): Promise<void> {
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
