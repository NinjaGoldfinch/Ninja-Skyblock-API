import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { getRedis } from '../../../utils/redis.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';

interface BazaarParams {
  itemId: string;
}

export async function bazaarRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/bazaar — all raw bazaar data
  app.get(
    '/v1/skyblock/bazaar',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get all raw bazaar data',
        description: 'Returns raw Hypixel bazaar data for all products. Equivalent to the Hypixel /v2/skyblock/bazaar endpoint.',
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
    async (request: FastifyRequest) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Single key read — entire bazaar stored as one chunk by the tracker
      const cached = await cacheGet<Record<string, unknown>>('warm', 'bazaar-all', 'latest');
      if (cached) {
        return {
          success: true,
          data: { products: cached.data, count: Object.keys(cached.data).length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation('No bazaar data available. The bazaar tracker may not have run yet.');
    },
  );

  // GET /v1/skyblock/bazaar/:itemId — raw Hypixel bazaar data for a product
  app.get<{ Params: BazaarParams }>(
    '/v1/skyblock/bazaar/:itemId',
    {
      schema: {
        tags: ['bazaar'],
        summary: 'Get raw bazaar product data',
        description: 'Returns raw Hypixel bazaar data for a product (quick_status, buy_summary, sell_summary). No processing.',
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
              data: { type: 'object', additionalProperties: true, description: 'Raw Hypixel bazaar product data.' },
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

      // Read the raw cached data — the bazaar tracker stores processed data in warm cache,
      // but we want raw. Check if we have a raw version cached.
      const redis = getRedis();
      const rawKey = `cache:warm:bazaar-raw:${itemId}`;
      const raw = await redis.get(rawKey);

      if (raw) {
        const entry = JSON.parse(raw) as { data: Record<string, unknown>; cached_at: number };
        const ageSeconds = Math.floor((Date.now() - entry.cached_at) / 1000);
        return {
          success: true,
          data: entry.data,
          meta: { cached: true, cache_age_seconds: ageSeconds, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No bazaar data available for item ${itemId}. The bazaar tracker may not have run yet.`);
    },
  );
}
