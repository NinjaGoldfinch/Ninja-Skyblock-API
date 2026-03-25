import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchPlayerAuctions } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { HypixelAuction } from '../../../types/hypixel.js';

interface PlayerAuctionParams {
  playerUuid: string;
}

interface AuctionSummary {
  auction_id: string;
  item_name: string;
  starting_bid: number;
  highest_bid: number;
  bin: boolean;
  tier: string;
  category: string;
  start: number;
  end: number;
}

function summarizeAuction(auction: HypixelAuction): AuctionSummary {
  return {
    auction_id: auction.uuid,
    item_name: auction.item_name,
    starting_bid: auction.starting_bid,
    highest_bid: auction.highest_bid_amount,
    bin: auction.bin,
    tier: auction.tier,
    category: auction.category,
    start: auction.start,
    end: auction.end,
  };
}

export async function playerAuctionsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: PlayerAuctionParams }>(
    '/v1/skyblock/auctions/player/:playerUuid',
    {
      schema: {
        tags: ['auctions'],
        summary: "Get a player's active auctions",
        description: "Returns all active auction listings for a player. Includes both BIN and regular auctions.",
        params: {
          type: 'object',
          required: ['playerUuid'],
          properties: {
            playerUuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'Minecraft player UUID (with or without hyphens).',
            },
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
          404: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PlayerAuctionParams }>) => {
      const playerUuid = request.params.playerUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Check cache
      const cached = await cacheGet<AuctionSummary[]>('hot', 'player-auctions', playerUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { player_uuid: playerUuid, auctions: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Fetch from Hypixel
      const response = await fetchPlayerAuctions(playerUuid);
      if (!response.auctions || response.auctions.length === 0) {
        throw errors.playerNotFound(playerUuid);
      }

      const auctions = response.auctions.map(summarizeAuction);
      await cacheSet('hot', 'player-auctions', playerUuid, auctions);

      return {
        success: true,
        data: { player_uuid: playerUuid, auctions, count: auctions.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
