import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { LowestBinData } from '../../../workers/auction-scanner.js';

interface AuctionParams {
  item: string;
}

export async function auctionsRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/auctions/lowest/:item — lowest BIN for an item
  app.get<{ Params: AuctionParams }>(
    '/v1/skyblock/auctions/lowest/:item',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get lowest BIN price',
        description: 'Returns the current lowest Buy-It-Now listing for an item. Data is updated by the auction scanner every 45 seconds.',
        params: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { type: 'string', description: 'Item name as it appears in the auction house.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true, description: 'Lowest BIN listing details.' },
              meta: { $ref: 'response-meta#' },
            },
          },
          400: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: AuctionParams }>) => {
      const { item } = request.params;
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<LowestBinData>('hot', 'auction-lowest', item);
      if (cached) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No auction data available for item "${item}". The auction scanner may not have run yet, or no BIN listings exist.`);
    },
  );
}
