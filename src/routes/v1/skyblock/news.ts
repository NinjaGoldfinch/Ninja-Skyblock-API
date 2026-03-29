import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchNews } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import type { HypixelNewsResponse } from '../../../types/hypixel.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('route:news');

export async function newsRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/skyblock/news',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get SkyBlock news',
        description: 'Returns recent SkyBlock news and updates. Public endpoint, no API key required.',
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

      const cached = await cacheGet<HypixelNewsResponse['items']>('warm', 'news', 'latest');
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { items: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheNews().catch((err) => log.error({ err }, 'Background news refresh failed'));
        return {
          success: true,
          data: { items: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheNews();
      return {
        success: true,
        data: { items: data, count: data.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCacheNews(): Promise<HypixelNewsResponse['items']> {
  const response = await fetchNews();
  const items = response.items ?? [];
  await cacheSet('warm', 'news', 'latest', items);
  return items;
}
