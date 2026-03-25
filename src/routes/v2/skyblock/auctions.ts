import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { getRedis } from '../../../utils/redis.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { LowestBinData } from '../../../workers/auction-scanner.js';

interface AuctionParams {
  item: string;
}

interface AuctionQuery {
  search?: string;
}

/**
 * Scan Redis keys matching a pattern and return matching LowestBinData.
 * Used for search when exact key doesn't match.
 */
async function searchAuctionCache(searchTerm: string): Promise<LowestBinData | null> {
  const redis = getRedis();
  const pattern = `cache:hot:auction-lowest:*`;
  const lowerSearch = searchTerm.toLowerCase();

  let cursor = '0';
  let bestMatch: { data: LowestBinData; key: string } | null = null;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;

    for (const key of keys) {
      const keyName = key.replace('cache:hot:auction-lowest:', '');
      if (keyName.toLowerCase().includes(lowerSearch)) {
        const raw = await redis.get(key);
        if (raw) {
          const entry = JSON.parse(raw) as { data: LowestBinData };
          // Pick the one with the lowest price if multiple match
          if (!bestMatch || entry.data.lowest.price < bestMatch.data.lowest.price) {
            bestMatch = { data: entry.data, key: keyName };
          }
        }
      }
    }
  } while (cursor !== '0');

  return bestMatch?.data ?? null;
}

export async function v2AuctionsRoute(app: FastifyInstance): Promise<void> {
  // GET /v2/skyblock/auctions/lowest — all items with lowest BIN
  app.get(
    '/v2/skyblock/auctions/lowest',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get all lowest BIN prices',
        description: 'Returns the lowest BIN listing for every item tracked by the auction scanner, sorted by base item name.',
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

      const redis = getRedis();
      const items: Array<{ base_item: string; lowest_price: number; count: number }> = [];

      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'cache:hot:auction-lowest:*', 'COUNT', 500);
        cursor = nextCursor;

        if (keys.length > 0) {
          const values = await redis.mget(...keys);
          for (let i = 0; i < keys.length; i++) {
            const raw = values[i];
            if (!raw) continue;
            const entry = JSON.parse(raw) as { data: LowestBinData; cached_at: number };
            items.push({
              base_item: entry.data.base_item,
              lowest_price: entry.data.lowest.price,
              count: entry.data.count,
            });
          }
        }
      } while (cursor !== '0');

      items.sort((a, b) => a.base_item.localeCompare(b.base_item));

      return {
        success: true,
        data: { items, count: items.length },
        meta: { cached: true, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/auctions/lowest/:item — lowest BIN for an item
  app.get<{ Params: AuctionParams }>(
    '/v2/skyblock/auctions/lowest/:item',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get lowest BIN price',
        description: 'Returns the lowest BIN listing for an item by base name (e.g. "Hyperion", "Aspect of the End"). Searches across all reforge/star variants and returns the cheapest.',
        params: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { type: 'string', description: 'Base item name (without reforges/stars).' },
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
          400: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: AuctionParams }>) => {
      const { item } = request.params;
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Try exact match first
      const cached = await cacheGet<LowestBinData>('hot', 'auction-lowest', item);
      if (cached) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Fall back to search
      const searched = await searchAuctionCache(item);
      if (searched) {
        return {
          success: true,
          data: searched,
          meta: { cached: true, cache_age_seconds: null, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No auction data found for "${item}". The auction scanner may not have run yet, or no BIN listings exist for this item.`);
    },
  );

  // GET /v2/skyblock/auctions/search — search auctions by name
  app.get<{ Querystring: AuctionQuery }>(
    '/v2/skyblock/auctions/search',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Search auction items',
        description: 'Search for items in the auction cache by name. Returns all matching base items with their lowest BIN and listing count.',
        querystring: {
          type: 'object',
          required: ['search'],
          properties: {
            search: { type: 'string', minLength: 2, description: 'Search term (minimum 2 characters).' },
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
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AuctionQuery }>) => {
      const search = request.query.search ?? '';
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const redis = getRedis();
      const lowerSearch = search.toLowerCase();
      const results: Array<{ base_item: string; lowest_price: number; count: number }> = [];

      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'cache:hot:auction-lowest:*', 'COUNT', 200);
        cursor = nextCursor;

        for (const key of keys) {
          const keyName = key.replace('cache:hot:auction-lowest:', '');
          if (keyName.toLowerCase().includes(lowerSearch)) {
            const raw = await redis.get(key);
            if (raw) {
              const entry = JSON.parse(raw) as { data: LowestBinData };
              results.push({
                base_item: entry.data.base_item,
                lowest_price: entry.data.lowest.price,
                count: entry.data.count,
              });
            }
          }
        }
      } while (cursor !== '0');

      results.sort((a, b) => a.lowest_price - b.lowest_price);

      return {
        success: true,
        data: { items: results, count: results.length },
        meta: { cached: true, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
