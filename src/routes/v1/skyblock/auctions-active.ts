import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { TrackedAuction } from '../../../workers/auction-scanner.js';

export async function auctionsActiveRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/auctions/active — all tracked active auctions
  app.get(
    '/v1/skyblock/auctions/active',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get all active tracked auctions',
        description: 'Returns all auctions currently being tracked by the auction scanner. Includes base_item and skyblock_id resolution.',
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
    async (request: FastifyRequest) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<Record<string, TrackedAuction>>('hot', 'auctions-active', 'latest');
      if (cached) {
        const count = Object.keys(cached.data).length;
        return {
          success: true,
          data: { auctions: cached.data, count },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation('Active auction data not available yet. The auction worker may not have run.');
    },
  );

  // GET /v1/skyblock/auctions/pending — auctions awaiting sold/expired confirmation
  app.get(
    '/v1/skyblock/auctions/pending',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get pending auctions',
        description: 'Returns auctions that disappeared from the active pages and are awaiting confirmation from the ended endpoint.',
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

      const cached = await cacheGet<Record<string, TrackedAuction>>('hot', 'auctions-pending', 'latest');
      const count = cached ? Object.keys(cached.data).length : 0;
      return {
        success: true,
        data: { auctions: cached?.data ?? {}, count },
        meta: { cached: true, cache_age_seconds: cached?.cache_age_seconds ?? null, timestamp: Date.now() },
      };
    },
  );

}
