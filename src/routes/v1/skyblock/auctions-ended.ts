import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchEndedAuctions } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import type { HypixelEndedAuction } from '../../../types/hypixel.js';

interface EndedAuctionSummary {
  auction_id: string;
  seller: string;
  buyer: string;
  price: number;
  bin: boolean;
  timestamp: number;
}

function summarizeEnded(auction: HypixelEndedAuction): EndedAuctionSummary {
  return {
    auction_id: auction.auction_id,
    seller: auction.seller,
    buyer: auction.buyer,
    price: auction.price,
    bin: auction.bin,
    timestamp: auction.timestamp,
  };
}

export async function auctionsEndedRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/v1/skyblock/auctions/ended',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get recently ended auctions',
        description: 'Returns auctions that ended in the last 60 seconds. Updated by Hypixel every minute. Useful for tracking sale prices.',
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

      // Check cache (short TTL — data changes every minute)
      const cached = await cacheGet<EndedAuctionSummary[]>('hot', 'auctions-ended', 'latest');
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { auctions: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const response = await fetchEndedAuctions();
      const auctions = response.auctions.map(summarizeEnded);
      await cacheSet('hot', 'auctions-ended', 'latest', auctions);

      return {
        success: true,
        data: { auctions, count: auctions.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
