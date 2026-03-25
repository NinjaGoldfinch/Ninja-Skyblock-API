import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
import { errors } from '../../../utils/errors.js';
import type { BazaarProductData } from '../../../workers/bazaar-tracker.js';
import type { HypixelBazaarProduct } from '../../../types/hypixel.js';

interface BazaarParams {
  itemId: string;
}

interface HistoryQuery {
  range?: '1h' | '6h' | '24h' | '7d' | '30d';
}

interface RawSnapshotRow {
  item_id: string;
  raw_data: HypixelBazaarProduct;
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
  // GET /v1/skyblock/bazaar/:itemId — current price data from warm cache
  app.get<{ Params: BazaarParams }>(
    '/v1/skyblock/bazaar/:itemId',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get bazaar product data',
        description: 'Returns current buy/sell prices (instant and average), volume, and top orders for a bazaar product.',
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
              data: { type: 'object', additionalProperties: true, description: 'Bazaar product data with instant and average prices.' },
              meta: { $ref: 'response-meta#' },
            },
          },
          400: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams }>) => {
      const { itemId } = request.params;
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

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

  // GET /v1/skyblock/bazaar/:itemId/history — price history computed from raw snapshots
  app.get<{ Params: BazaarParams; Querystring: HistoryQuery }>(
    '/v1/skyblock/bazaar/:itemId/history',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get bazaar price history',
        description: 'Returns historical price snapshots for a bazaar product computed from raw Hypixel data.\n\nIncludes both instant prices (from order book) and weighted averages, plus a summary with period averages.',
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
            range: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h', description: 'Time range for history.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true, description: 'Price history with datapoints and period summary.' },
              meta: { $ref: 'response-meta#' },
            },
          },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: BazaarParams; Querystring: HistoryQuery }>) => {
      const { itemId } = request.params;
      const range = request.query.range ?? '24h';
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const interval = RANGE_TO_INTERVAL[range] ?? '24 hours';
      const resolution = RANGE_TO_RESOLUTION[range] ?? '5m';

      let rows: RawSnapshotRow[];
      try {
        rows = await postgrestSelect<RawSnapshotRow>({
          table: 'bazaar_snapshots',
          query: {
            item_id: `eq.${itemId}`,
            recorded_at: `gte.${new Date(Date.now() - parseDuration(interval)).toISOString()}`,
          },
          order: 'recorded_at.asc',
          select: 'item_id,raw_data,recorded_at',
        });
      } catch {
        rows = [];
      }

      const datapoints = rows.map((row) => {
        const raw = row.raw_data;
        const qs = raw.quick_status;
        return {
          timestamp: new Date(row.recorded_at).getTime(),
          instant_buy_price: raw.sell_summary?.[0]?.pricePerUnit ?? qs.buyPrice,
          instant_sell_price: raw.buy_summary?.[0]?.pricePerUnit ?? qs.sellPrice,
          avg_buy_price: qs.buyPrice,
          avg_sell_price: qs.sellPrice,
          buy_volume: qs.buyVolume,
          sell_volume: qs.sellVolume,
        };
      });

      const count = datapoints.length;
      const summary = count > 0 ? {
        avg_instant_buy: Math.round((datapoints.reduce((s, d) => s + d.instant_buy_price, 0) / count) * 100) / 100,
        avg_instant_sell: Math.round((datapoints.reduce((s, d) => s + d.instant_sell_price, 0) / count) * 100) / 100,
        avg_buy: Math.round((datapoints.reduce((s, d) => s + d.avg_buy_price, 0) / count) * 100) / 100,
        avg_sell: Math.round((datapoints.reduce((s, d) => s + d.avg_sell_price, 0) / count) * 100) / 100,
      } : null;

      return {
        success: true,
        data: {
          item_id: itemId,
          range,
          resolution,
          count,
          summary,
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
