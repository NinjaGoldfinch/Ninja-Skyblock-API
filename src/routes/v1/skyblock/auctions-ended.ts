import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { HypixelEndedAuction } from '../../../types/hypixel.js';

export async function auctionsEndedRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/skyblock/auctions/ended',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get recently ended auctions',
        description: 'Returns auctions that ended in the last 60 seconds. Data kept up-to-date by the auction-sold worker.',
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

      // Read from cache populated by auction-sold worker
      const cached = await cacheGet<HypixelEndedAuction[]>('hot', 'auctions-ended', 'latest');
      if (cached) {
        return {
          success: true,
          data: { auctions: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation('Ended auction data not available yet. The auction-sold worker may not have run.');
    },
  );
}
