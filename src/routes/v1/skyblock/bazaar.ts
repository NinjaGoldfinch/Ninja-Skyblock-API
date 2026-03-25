import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
import { errors } from '../../../utils/errors.js';

interface BazaarParams {
  itemId: string;
}

interface HistoryQuery {
  range?: '1h' | '6h' | '24h' | '7d' | '30d';
}

interface BazaarProductData {
  item_id: string;
  buy_price: number;
  sell_price: number;
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  buy_moving_week: number;
  sell_moving_week: number;
}

interface BazaarSnapshotRow {
  item_id: string;
  buy_price: number;
  sell_price: number;
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  recorded_at: string;
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

export async function bazaarRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/bazaar/:itemId — current price data
  app.get<{ Params: BazaarParams }>(
    '/v1/skyblock/bazaar/:itemId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['itemId'],
          properties: {
            itemId: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams }>) => {
      const { itemId } = request.params;
      await enforceClientRateLimit(request.clientId);

      const cached = await cacheGet<BazaarProductData>('warm', 'bazaar', itemId);
      if (cached) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No bazaar data available for item ${itemId}. The bazaar tracker may not have run yet.`);
    },
  );

  // GET /v1/skyblock/bazaar/:itemId/history — price history
  app.get<{ Params: BazaarParams; Querystring: HistoryQuery }>(
    '/v1/skyblock/bazaar/:itemId/history',
    {
      schema: {
        params: {
          type: 'object',
          required: ['itemId'],
          properties: {
            itemId: { type: 'string' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams; Querystring: HistoryQuery }>) => {
      const { itemId } = request.params;
      const range = request.query.range ?? '24h';
      await enforceClientRateLimit(request.clientId);

      const interval = RANGE_TO_INTERVAL[range] ?? '24 hours';
      const resolution = RANGE_TO_RESOLUTION[range] ?? '5m';

      let rows: BazaarSnapshotRow[];
      try {
        rows = await postgrestSelect<BazaarSnapshotRow>({
          table: 'bazaar_snapshots',
          query: {
            item_id: `eq.${itemId}`,
            recorded_at: `gte.${new Date(Date.now() - parseDuration(interval)).toISOString()}`,
          },
          order: 'recorded_at.asc',
          select: 'item_id,buy_price,sell_price,buy_volume,sell_volume,buy_orders,sell_orders,recorded_at',
        });
      } catch {
        rows = [];
      }

      const datapoints = rows.map((row) => ({
        timestamp: new Date(row.recorded_at).getTime(),
        buy_price: row.buy_price,
        sell_price: row.sell_price,
        buy_volume: row.buy_volume,
        sell_volume: row.sell_volume,
      }));

      return {
        success: true,
        data: {
          item_id: itemId,
          range,
          resolution,
          datapoints,
        },
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
