import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { getRedis } from '../../../utils/redis.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
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

interface LowestQuery {
  key_by?: 'name' | 'skyblock_id';
}

export async function v2AuctionsRoute(app: FastifyInstance): Promise<void> {
  // GET /v2/skyblock/auctions/lowest — all items with lowest BIN
  app.get<{ Querystring: LowestQuery }>(
    '/v2/skyblock/auctions/lowest',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get all lowest BIN prices',
        description: 'Returns the lowest BIN listing for every item. Use `?key_by=skyblock_id` to get a map keyed by SkyBlock item ID (for mod consumption).',
        querystring: {
          type: 'object',
          properties: {
            key_by: { type: 'string', enum: ['name', 'skyblock_id'], default: 'name', description: 'Key the response by item name or skyblock_id.' },
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
    async (request: FastifyRequest<{ Querystring: LowestQuery }>) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);
      const keyBy = request.query.key_by ?? 'name';

      if (keyBy === 'skyblock_id') {
        // Return keyed by skyblock_id — one GET, mod-friendly format
        const cached = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all-by-id', 'latest');
        if (cached) {
          return {
            success: true,
            data: cached.data,
            meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
          };
        }
      } else {
        // Return as sorted array keyed by name
        const cached = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all', 'latest');
        if (cached) {
          const items = Object.values(cached.data)
            .map((d) => ({
              skyblock_id: d.skyblock_id,
              base_item: d.base_item,
              lowest_price: d.lowest.price,
              auction_id: d.lowest.auction_id,
              item_name: d.lowest.item_name,
              seller_uuid: d.lowest.seller_uuid,
              tier: d.lowest.tier,
              count: d.count,
            }))
            .sort((a, b) => a.base_item.localeCompare(b.base_item));

          return {
            success: true,
            data: { items, count: items.length },
            meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
          };
        }
      }

      throw errors.validation('No auction data available yet. The auction scanner may not have run.');
    },
  );

  // GET /v2/skyblock/auctions/lowest/:item — lowest BIN for an item
  app.get<{ Params: AuctionParams }>(
    '/v2/skyblock/auctions/lowest/:item',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get lowest BIN price',
        description: 'Returns the lowest BIN listing for an item. Accepts base item name (e.g. "Hyperion") or SkyBlock item ID (e.g. "HYPERION"). Falls back to search if no exact match.',
        params: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { type: 'string', description: 'Base item name or SkyBlock item ID.' },
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

      // Try exact match by base item name
      const cached = await cacheGet<LowestBinData>('hot', 'auction-lowest', item);
      if (cached) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Try by skyblock_id (e.g. HYPERION, ASPECT_OF_THE_END)
      const byId = await cacheGet<LowestBinData>('hot', 'auction-lowest-id', item.toUpperCase());
      if (byId) {
        return {
          success: true,
          data: byId.data,
          meta: { cached: true, cache_age_seconds: byId.cache_age_seconds, timestamp: Date.now() },
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

  // GET /v2/skyblock/auctions/history — query completed auction history
  app.get<{ Querystring: HistoryQuery }>(
    '/v2/skyblock/auctions/history',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Query auction sale history',
        description: 'Returns completed auctions from Postgres. Filter by auction_id, skyblock_id, base_item, seller_uuid, buyer_uuid, or outcome. Results ordered by ended_at descending.',
        querystring: {
          type: 'object',
          properties: {
            auction_id: { type: 'string', description: 'Exact auction UUID.' },
            skyblock_id: { type: 'string', description: 'SkyBlock item ID (e.g. HYPERION).' },
            base_item: { type: 'string', description: 'Base item name (e.g. Hyperion).' },
            seller_uuid: { type: 'string', description: 'Seller player UUID.' },
            buyer_uuid: { type: 'string', description: 'Buyer player UUID.' },
            outcome: { type: 'string', enum: ['sold', 'expired', 'cancelled'], description: 'Auction outcome.' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Max results.' },
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
    async (request: FastifyRequest<{ Querystring: HistoryQuery }>) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const q = request.query;
      const query: Record<string, string> = {};
      if (q.auction_id) query['auction_id'] = `eq.${q.auction_id}`;
      if (q.skyblock_id) query['skyblock_id'] = `eq.${q.skyblock_id}`;
      if (q.base_item) query['base_item'] = `eq.${q.base_item}`;
      if (q.seller_uuid) query['seller_uuid'] = `eq.${q.seller_uuid}`;
      if (q.buyer_uuid) query['buyer_uuid'] = `eq.${q.buyer_uuid}`;
      if (q.outcome) query['outcome'] = `eq.${q.outcome}`;

      let rows: AuctionHistoryRow[];
      try {
        rows = await postgrestSelect<AuctionHistoryRow>({
          table: 'auction_history',
          query,
          order: 'ended_at.desc',
          limit: q.limit ?? 50,
        });
      } catch {
        rows = [];
      }

      return {
        success: true,
        data: { auctions: rows, count: rows.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/auctions/item-data/:auctionId — get item_bytes for an auction
  app.get<{ Params: { auctionId: string } }>(
    '/v2/skyblock/auctions/item-data/:auctionId',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get auction item NBT data',
        description: 'Returns the base64-encoded NBT item_bytes for an auction. Decode for enchantments, reforges, gemstones, stars, etc. Data stored in Postgres, available for active and completed auctions.',
        params: {
          type: 'object',
          required: ['auctionId'],
          properties: {
            auctionId: { type: 'string', description: 'Auction UUID.' },
          },
        },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
          404: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { auctionId: string } }>) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Try auction_item_data first (active auctions)
      let rows = await postgrestSelect<{ auction_id: string; item_bytes: string }>({
        table: 'auction_item_data',
        query: { auction_id: `eq.${request.params.auctionId}` },
        limit: 1,
      }).catch(() => [] as Array<{ auction_id: string; item_bytes: string }>);

      if (rows.length > 0) {
        return {
          success: true,
          data: { auction_id: rows[0]!.auction_id, item_bytes: rows[0]!.item_bytes },
          meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
        };
      }

      // Fall back to auction_history (completed auctions)
      const historyRows = await postgrestSelect<{ auction_id: string; item_bytes: string | null }>({
        table: 'auction_history',
        query: { auction_id: `eq.${request.params.auctionId}` },
        select: 'auction_id,item_bytes',
        limit: 1,
      }).catch(() => [] as Array<{ auction_id: string; item_bytes: string | null }>);

      if (historyRows.length > 0 && historyRows[0]!.item_bytes) {
        return {
          success: true,
          data: { auction_id: historyRows[0]!.auction_id, item_bytes: historyRows[0]!.item_bytes },
          meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
        };
      }

      throw errors.validation(`No item data found for auction ${request.params.auctionId}.`);
    },
  );
}

interface HistoryQuery {
  auction_id?: string;
  skyblock_id?: string;
  base_item?: string;
  seller_uuid?: string;
  buyer_uuid?: string;
  outcome?: 'sold' | 'expired' | 'cancelled';
  limit?: number;
}

interface AuctionHistoryRow {
  auction_id: string;
  skyblock_id: string | null;
  base_item: string;
  item_name: string;
  seller_uuid: string;
  buyer_uuid: string | null;
  starting_bid: number;
  final_price: number;
  bin: boolean;
  tier: string | null;
  category: string | null;
  outcome: string;
  started_at: string;
  ended_at: string;
  item_bytes: string | null;
  item_lore: string | null;
}
