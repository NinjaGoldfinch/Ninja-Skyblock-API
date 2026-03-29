import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchFireSales } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import type { HypixelFireSalesResponse } from '../../../types/hypixel.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('route:firesales');

export async function firesalesRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/skyblock/firesales',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get active fire sales',
        description: 'Returns currently active SkyBlock fire sales. Public endpoint, no API key required.',
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

      const cached = await cacheGet<HypixelFireSalesResponse['sales']>('warm', 'firesales', 'latest');
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { sales: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheFireSales().catch((err) => log.error({ err }, 'Background firesales refresh failed'));
        return {
          success: true,
          data: { sales: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheFireSales();
      return {
        success: true,
        data: { sales: data, count: data.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCacheFireSales(): Promise<HypixelFireSalesResponse['sales']> {
  const response = await fetchFireSales();
  const sales = response.sales ?? [];
  await cacheSet('warm', 'firesales', 'latest', sales);
  return sales;
}
