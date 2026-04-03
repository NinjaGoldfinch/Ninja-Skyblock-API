import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { getRedis } from '../../../utils/redis.js';
import { postgrestSelect } from '../../../services/postgrest-client.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { LowestBinData, TrackedAuction } from '../../../workers/auction-scanner.js';

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
  // Also search with underscores converted to spaces (LAVA_RUNE → lava rune)
  const lowerSearchSpaces = lowerSearch.replace(/_/g, ' ');

  let cursor = '0';
  let bestMatch: { data: LowestBinData; key: string } | null = null;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = nextCursor;

    for (const key of keys) {
      const keyName = key.replace('cache:hot:auction-lowest:', '');
      const lowerKey = keyName.toLowerCase();
      if (lowerKey.includes(lowerSearch) || lowerKey.includes(lowerSearchSpaces)) {
        const raw = await redis.get(key);
        if (raw) {
          const entry = JSON.parse(raw) as { data: LowestBinData };
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
  limit?: number;
  offset?: number;
  sort?: 'lowest_price' | 'count' | 'item_name' | 'tier';
  order?: 'asc' | 'desc';
  search?: string;
  tier?: string;
}

const TIER_RANK: Record<string, number> = {
  COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4,
  MYTHIC: 5, SPECIAL: 6, VERY_SPECIAL: 7, SUPREME: 8, ULTIMATE: 9,
};

export async function v2AuctionsRoute(app: FastifyInstance): Promise<void> {
  // GET /v2/skyblock/auctions/lowest — all items with lowest BIN
  app.get<{ Querystring: LowestQuery }>(
    '/v2/skyblock/auctions/lowest',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get all lowest BIN prices',
        description: 'Returns the lowest BIN listing for every item. Use `?key_by=skyblock_id` to get a map keyed by SkyBlock item ID (for mod consumption). Supports pagination, sorting, search, and tier filtering.',
        querystring: {
          type: 'object',
          properties: {
            key_by: { type: 'string', enum: ['name', 'skyblock_id'], default: 'name', description: 'Key the response by item name or skyblock_id. Pagination params are ignored when key_by=skyblock_id.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 40, description: 'Max items to return.' },
            offset: { type: 'integer', minimum: 0, default: 0, description: 'Number of items to skip.' },
            sort: { type: 'string', enum: ['lowest_price', 'count', 'item_name', 'tier'], default: 'lowest_price', description: 'Field to sort by.' },
            order: { type: 'string', enum: ['asc', 'desc'], default: 'asc', description: 'Sort direction.' },
            search: { type: 'string', description: 'Case-insensitive substring match on item_name, base_item, or skyblock_id.' },
            tier: { type: 'string', description: 'Exact match filter on tier (e.g. LEGENDARY).' },
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
        // Return keyed by skyblock_id — one GET, mod-friendly format (no pagination)
        const cached = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all-by-id', 'latest');
        if (cached) {
          return {
            success: true,
            data: cached.data,
            meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
          };
        }
      } else {
        // Return as paginated array keyed by name
        const cached = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all', 'latest');
        if (cached) {
          const lowerSearch = request.query.search?.toLowerCase();
          const tierFilter = request.query.tier?.toUpperCase();

          let items = Object.values(cached.data)
            .map((d) => ({
              skyblock_id: d.skyblock_id,
              base_item: d.base_item,
              lowest_price: d.lowest.price,
              auction_id: d.lowest.auction_id,
              item_name: d.lowest.item_name,
              seller_uuid: d.lowest.seller_uuid,
              tier: d.lowest.tier,
              count: d.count,
            }));

          // Filter by search
          if (lowerSearch) {
            items = items.filter((i) =>
              i.item_name.toLowerCase().includes(lowerSearch) ||
              i.base_item.toLowerCase().includes(lowerSearch) ||
              (i.skyblock_id?.toLowerCase().includes(lowerSearch) ?? false),
            );
          }

          // Filter by tier
          if (tierFilter) {
            items = items.filter((i) => i.tier?.toUpperCase() === tierFilter);
          }

          const total = items.length;

          // Sort
          const sortField = request.query.sort ?? 'lowest_price';
          const orderDesc = (request.query.order ?? 'asc') === 'desc';
          const dir = orderDesc ? -1 : 1;

          switch (sortField) {
            case 'lowest_price':
              items.sort((a, b) => dir * (a.lowest_price - b.lowest_price));
              break;
            case 'count':
              items.sort((a, b) => dir * (a.count - b.count));
              break;
            case 'item_name':
              items.sort((a, b) => dir * a.item_name.localeCompare(b.item_name));
              break;
            case 'tier':
              items.sort((a, b) => dir * ((TIER_RANK[a.tier?.toUpperCase() ?? ''] ?? -1) - (TIER_RANK[b.tier?.toUpperCase() ?? ''] ?? -1)));
              break;
          }

          // Paginate
          const limit = Math.min(request.query.limit ?? 40, 200);
          const offset = request.query.offset ?? 0;
          const page = items.slice(offset, offset + limit);

          return {
            success: true,
            data: { items: page, total, limit, offset },
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

      // Try matching skyblock_id against the bulk cache (catches items where per-ID cache wasn't written)
      const allByIdCache = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all-by-id', 'latest');
      if (allByIdCache) {
        const match = allByIdCache.data[item.toUpperCase()];
        if (match) {
          return {
            success: true,
            data: match,
            meta: { cached: true, cache_age_seconds: allByIdCache.cache_age_seconds, timestamp: Date.now() },
          };
        }
      }

      // Try matching by name from bulk cache (handles skyblock_id format → display name matching)
      const allCache = await cacheGet<Record<string, LowestBinData>>('hot', 'auction-lowest-all', 'latest');
      if (allCache) {
        const lowerItem = item.toLowerCase();
        // Convert SCREAMING_SNAKE_CASE to space-separated for matching (LAVA_RUNE_I → lava rune i)
        const asSpaces = lowerItem.replace(/_/g, ' ');
        for (const data of Object.values(allCache.data)) {
          const lowerBase = data.base_item.toLowerCase();
          const lowerId = data.skyblock_id?.toLowerCase() ?? '';
          if (lowerBase === lowerItem || lowerBase === asSpaces || lowerId === lowerItem) {
            return {
              success: true,
              data,
              meta: { cached: true, cache_age_seconds: allCache.cache_age_seconds, timestamp: Date.now() },
            };
          }
        }
      }

      // Fall back to fuzzy search (substring match on Redis keys + skyblock_id)
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

  // GET /v2/skyblock/auctions/recently-sold — latest sold auctions from cache
  app.get(
    '/v2/skyblock/auctions/recently-sold',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get recently sold auctions',
        description: 'Returns the most recently confirmed sold auctions from cache. Updated each scan cycle.',
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
    async (request) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<AuctionHistoryRow[]>('hot', 'auctions-recently-sold', 'latest');
      if (cached) {
        return {
          success: true,
          data: { auctions: cached.data, count: cached.data.length },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      return {
        success: true,
        data: { auctions: [], count: 0 },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
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
            bin: { type: 'boolean', description: 'Filter BIN-only auctions.' },
            tier: { type: 'string', description: 'Item tier (e.g. LEGENDARY, MYTHIC).' },
            min_price: { type: 'integer', minimum: 0, description: 'Minimum final price.' },
            max_price: { type: 'integer', minimum: 0, description: 'Maximum final price.' },
            since: { type: 'string', format: 'date-time', description: 'Only auctions ending after this ISO timestamp.' },
            before: { type: 'string', format: 'date-time', description: 'Only auctions ending before this ISO timestamp.' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Max results.' },
            offset: { type: 'integer', minimum: 0, default: 0, description: 'Offset for pagination.' },
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
      if (q.bin !== undefined) query['bin'] = `eq.${q.bin}`;
      if (q.tier) query['tier'] = `eq.${q.tier}`;
      if (q.min_price !== undefined) query['final_price'] = `gte.${q.min_price}`;
      if (q.max_price !== undefined) {
        // PostgREST supports multiple conditions on the same column via AND logic
        // but not via duplicate keys — use a combined filter if both min and max are set
        if (q.min_price !== undefined) {
          query['and'] = `(final_price.gte.${q.min_price},final_price.lte.${q.max_price})`;
          delete query['final_price'];
        } else {
          query['final_price'] = `lte.${q.max_price}`;
        }
      }
      if (q.since) query['ended_at'] = `gte.${q.since}`;
      if (q.before) {
        if (q.since) {
          const existing = query['and'];
          const timeFilter = `(ended_at.gte.${q.since},ended_at.lte.${q.before})`;
          query['and'] = existing ? `${existing},${timeFilter}` : timeFilter;
          delete query['ended_at'];
        } else {
          query['ended_at'] = `lte.${q.before}`;
        }
      }

      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;

      let rows: AuctionHistoryRow[];
      try {
        rows = await postgrestSelect<AuctionHistoryRow>({
          table: 'auction_history',
          query,
          order: 'ended_at.desc',
          limit,
          offset,
        });
      } catch {
        rows = [];
      }

      return {
        success: true,
        data: { auctions: rows, count: rows.length, limit, offset },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // GET /v2/skyblock/auctions/browse — browse/search active auctions with filters
  app.get<{ Querystring: BrowseQuery }>(
    '/v2/skyblock/auctions/browse',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Browse active auctions',
        description: 'Search and filter currently active auctions. Reads from the in-memory tracked auction cache. Supports text search, filtering by item ID/category/tier/BIN/price range, sorting, and pagination.',
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', minLength: 2, description: 'Search item names (case-insensitive substring match, minimum 2 chars).' },
            skyblock_id: { type: 'string', description: 'Filter by SkyBlock item ID (e.g. HYPERION). Case-insensitive.' },
            seller_uuid: { type: 'string', description: 'Filter by seller player UUID.' },
            category: { type: 'string', description: 'Filter by auction category (e.g. weapon, armor, accessories).' },
            tier: { type: 'string', description: 'Filter by item tier (e.g. LEGENDARY, MYTHIC). Case-insensitive.' },
            bin: { type: 'boolean', description: 'Filter BIN-only (true) or auction-only (false).' },
            min_price: { type: 'integer', minimum: 0, description: 'Minimum price (starting_bid for auctions, price for BIN).' },
            max_price: { type: 'integer', minimum: 0, description: 'Maximum price.' },
            sort_by: { type: 'string', enum: ['price_asc', 'price_desc', 'ending_soon', 'newest'], default: 'ending_soon', description: 'Sort order.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Max results per page.' },
            offset: { type: 'integer', minimum: 0, default: 0, description: 'Offset for pagination.' },
            include_item_bytes: { type: 'boolean', default: false, description: 'Include base64 NBT item_bytes for each auction (slower, fetches from Postgres).' },
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
    async (request: FastifyRequest<{ Querystring: BrowseQuery }>) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const q = request.query;
      const cached = await cacheGet<Record<string, TrackedAuction>>('hot', 'auctions-active', 'latest');
      if (!cached) {
        return {
          success: true,
          data: { auctions: [], total_matched: 0, limit: q.limit ?? 50, offset: q.offset ?? 0 },
          meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
        };
      }

      const lowerSearch = q.search?.toLowerCase();
      const lowerSkyblockId = q.skyblock_id?.toUpperCase();
      const lowerTier = q.tier?.toUpperCase();
      const lowerCategory = q.category?.toLowerCase();

      // Filter
      let results: TrackedAuction[] = [];
      for (const auction of Object.values(cached.data)) {
        if (lowerSearch && !auction.item_name.toLowerCase().includes(lowerSearch) && !auction.base_item.toLowerCase().includes(lowerSearch)) continue;
        if (lowerSkyblockId && auction.skyblock_id?.toUpperCase() !== lowerSkyblockId) continue;
        if (q.seller_uuid && auction.seller_uuid !== q.seller_uuid) continue;
        if (lowerCategory && auction.category.toLowerCase() !== lowerCategory) continue;
        if (lowerTier && auction.tier.toUpperCase() !== lowerTier) continue;
        if (q.bin !== undefined && auction.bin !== q.bin) continue;
        if (q.min_price !== undefined && auction.price < q.min_price) continue;
        if (q.max_price !== undefined && auction.price > q.max_price) continue;
        results.push(auction);
      }

      const totalMatched = results.length;

      // Sort
      const sortBy = q.sort_by ?? 'ending_soon';
      switch (sortBy) {
        case 'price_asc':
          results.sort((a, b) => a.price - b.price);
          break;
        case 'price_desc':
          results.sort((a, b) => b.price - a.price);
          break;
        case 'ending_soon':
          results.sort((a, b) => a.ends_at - b.ends_at);
          break;
        case 'newest':
          results.sort((a, b) => b.starts_at - a.starts_at);
          break;
      }

      // Paginate
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const page = results.slice(offset, offset + limit);

      // Optionally attach item_bytes
      let auctions: Array<TrackedAuction & { item_bytes?: string | null }> = page;
      if (q.include_item_bytes && page.length > 0) {
        const ids = page.map((a) => a.auction_id);
        const rows = await postgrestSelect<{ auction_id: string; item_bytes: string }>({
          table: 'auction_item_data',
          query: { auction_id: `in.(${ids.join(',')})` },
        }).catch(() => [] as Array<{ auction_id: string; item_bytes: string }>);

        const bytesMap = new Map(rows.map((r) => [r.auction_id, r.item_bytes]));
        auctions = page.map((a) => ({ ...a, item_bytes: bytesMap.get(a.auction_id) ?? null }));
      }

      return {
        success: true,
        data: { auctions, total_matched: totalMatched, limit, offset },
        meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
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

  // GET /v2/skyblock/auctions/price-history/:item — historical lowest-BIN price chart data
  app.get<{ Params: PriceHistoryParams; Querystring: PriceHistoryQuery }>(
    '/v2/skyblock/auctions/price-history/:item',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Get auction price history for an item',
        description: 'Returns time-series lowest-BIN price data for charting. Uses raw snapshots (~30s resolution) for 1h/6h/24h ranges, and pre-aggregated hourly buckets for 7d/30d. Accepts base_item name or skyblock_id.',
        params: {
          type: 'object',
          required: ['item'],
          properties: {
            item: { type: 'string', description: 'Item identifier — base_item name (e.g. "Hyperion") or skyblock_id (e.g. "HYPERION").' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h', description: 'Time range.' },
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
    async (request, reply) => {
      const { item } = request.params;
      const range = request.query.range ?? '24h';
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const interval = AH_RANGE_TO_INTERVAL[range] ?? '24 hours';
      const resolution = AH_RANGE_TO_RESOLUTION[range] ?? '~30s';
      const cutoff = new Date(Date.now() - parseDuration(interval)).toISOString();

      // Resolve item: try base_item, then skyblock_id
      const isSnakeCase = item === item.toUpperCase() && /[A-Z_]/.test(item);
      const filterField = isSnakeCase ? 'skyblock_id' : 'base_item';

      const useSummaries = range === '7d' || range === '30d';

      let datapoints: Array<{
        timestamp: number;
        lowest_bin: number;
        median_bin: number | null;
        listing_count: number;
        sale_count: number;
        avg_sale_price: number | null;
      }>;

      let resolvedItem = item;
      let resolvedSkyblockId: string | null = null;

      if (useSummaries) {
        const granularity = 'hourly';
        const rows = await querySummaries(item, filterField, granularity, cutoff);

        if (rows.length > 0) {
          resolvedItem = rows[0]!.base_item;
          resolvedSkyblockId = rows[0]!.skyblock_id;
        }

        datapoints = rows.map((row) => ({
          timestamp: new Date(row.bucket).getTime(),
          lowest_bin: row.avg_lowest_bin,
          median_bin: row.avg_median_bin,
          listing_count: Math.round(row.avg_listing_count),
          sale_count: row.total_sales,
          avg_sale_price: row.avg_sale_price,
        }));
      } else {
        let rows: AuctionSnapshotRow[];
        try {
          rows = await postgrestSelect<AuctionSnapshotRow>({
            table: 'auction_price_snapshots',
            query: { [filterField]: `eq.${item}`, recorded_at: `gte.${cutoff}` },
            order: 'recorded_at.asc',
            select: 'base_item,skyblock_id,lowest_bin,median_bin,listing_count,sale_count,avg_sale_price,recorded_at',
          });
        } catch {
          rows = [];
        }

        // Fallback: try alternate field
        if (rows.length === 0) {
          const altField = filterField === 'base_item' ? 'skyblock_id' : 'base_item';
          try {
            rows = await postgrestSelect<AuctionSnapshotRow>({
              table: 'auction_price_snapshots',
              query: { [altField]: `eq.${item}`, recorded_at: `gte.${cutoff}` },
              order: 'recorded_at.asc',
              select: 'base_item,skyblock_id,lowest_bin,median_bin,listing_count,sale_count,avg_sale_price,recorded_at',
            });
          } catch {
            rows = [];
          }
        }

        if (rows.length > 0) {
          resolvedItem = rows[0]!.base_item;
          resolvedSkyblockId = rows[0]!.skyblock_id;

          datapoints = rows.map((row) => ({
            timestamp: new Date(row.recorded_at).getTime(),
            lowest_bin: row.lowest_bin,
            median_bin: row.median_bin,
            listing_count: row.listing_count,
            sale_count: row.sale_count,
            avg_sale_price: row.avg_sale_price,
          }));
        } else {
          // No raw snapshots yet — fall back to minute summaries, then hourly
          const fallbackLimit = RANGE_TO_SUMMARY_LIMIT[range] ?? 60;
          const fallbackRows = await queryRecentSummaries(item, filterField, fallbackLimit);

          if (fallbackRows.length > 0) {
            resolvedItem = fallbackRows[0]!.base_item;
            resolvedSkyblockId = fallbackRows[0]!.skyblock_id;
          }

          datapoints = fallbackRows.map((row) => ({
            timestamp: new Date(row.bucket).getTime(),
            lowest_bin: row.avg_lowest_bin,
            median_bin: row.avg_median_bin,
            listing_count: Math.round(row.avg_listing_count),
            sale_count: row.total_sales,
            avg_sale_price: row.avg_sale_price,
          }));
        }
      }

      const count = datapoints.length;
      const summary = count > 0 ? {
        avg_lowest_bin: Math.round((datapoints.reduce((s, d) => s + d.lowest_bin, 0) / count) * 100) / 100,
        min_lowest_bin: Math.min(...datapoints.map((d) => d.lowest_bin)),
        max_lowest_bin: Math.max(...datapoints.map((d) => d.lowest_bin)),
        total_sales: datapoints.reduce((s, d) => s + d.sale_count, 0),
        avg_sale_price: (() => {
          const withSales = datapoints.filter((d) => d.avg_sale_price != null);
          if (withSales.length === 0) return null;
          return Math.round((withSales.reduce((s, d) => s + d.avg_sale_price!, 0) / withSales.length) * 100) / 100;
        })(),
      } : null;

      const lastTs = count > 0 ? datapoints[count - 1]!.timestamp : 0;
      const etag = `"ah-${item}-${range}-${lastTs}"`;

      const ifNoneMatch = request.headers['if-none-match'];
      if (ifNoneMatch === etag) {
        void reply.code(304);
        return;
      }

      const maxAge = AH_RANGE_TO_MAX_AGE[range] ?? 60;
      void reply.header('Cache-Control', `public, max-age=${maxAge}`);
      void reply.header('ETag', etag);

      return {
        success: true,
        data: { item: resolvedItem, skyblock_id: resolvedSkyblockId, range, resolution, count, sparse: !useSummaries, summary, datapoints },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
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
  bin?: boolean;
  tier?: string;
  min_price?: number;
  max_price?: number;
  since?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

interface BrowseQuery {
  search?: string;
  skyblock_id?: string;
  seller_uuid?: string;
  category?: string;
  tier?: string;
  bin?: boolean;
  min_price?: number;
  max_price?: number;
  sort_by?: 'price_asc' | 'price_desc' | 'ending_soon' | 'newest';
  limit?: number;
  offset?: number;
  include_item_bytes?: boolean;
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
}

// --- Price history types ---

interface PriceHistoryParams {
  item: string;
}

interface PriceHistoryQuery {
  range?: '1h' | '6h' | '24h' | '7d' | '30d';
}

interface AuctionSnapshotRow {
  base_item: string;
  skyblock_id: string | null;
  lowest_bin: number;
  median_bin: number | null;
  listing_count: number;
  sale_count: number;
  avg_sale_price: number | null;
  recorded_at: string;
}

interface AuctionSummaryRow {
  base_item: string;
  skyblock_id: string | null;
  bucket: string;
  avg_lowest_bin: number;
  avg_median_bin: number | null;
  avg_listing_count: number;
  total_sales: number;
  avg_sale_price: number | null;
}

const AH_RANGE_TO_INTERVAL: Record<string, string> = {
  '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days',
};

const AH_RANGE_TO_RESOLUTION: Record<string, string> = {
  '1h': '~60s', '6h': '~60s', '24h': '~60s', '7d': '1h', '30d': '1h',
};

const AH_RANGE_TO_MAX_AGE: Record<string, number> = {
  '1h': 10, '6h': 30, '24h': 60, '7d': 3600, '30d': 3600,
};

// When falling back to summaries for short ranges, how many recent rows to fetch
const RANGE_TO_SUMMARY_LIMIT: Record<string, number> = {
  '1h': 60, '6h': 360, '24h': 1440,
};

const SUMMARY_SELECT = 'base_item,skyblock_id,bucket,avg_lowest_bin,avg_median_bin,avg_listing_count,total_sales,avg_sale_price';

/** Query summaries table with cutoff, trying both field names. */
async function querySummaries(
  item: string, primaryField: string, granularity: string, cutoff: string,
): Promise<AuctionSummaryRow[]> {
  const fields = [primaryField, primaryField === 'base_item' ? 'skyblock_id' : 'base_item'];

  for (const field of fields) {
    try {
      const rows = await postgrestSelect<AuctionSummaryRow>({
        table: 'auction_price_summaries',
        query: { [field]: `eq.${item}`, granularity: `eq.${granularity}`, bucket: `gte.${cutoff}` },
        order: 'bucket.asc',
        select: SUMMARY_SELECT,
      });
      if (rows.length > 0) return rows;
    } catch { /* continue to alternate field */ }
  }
  return [];
}

/** Fetch the most recent N summary rows for an item (minute first, then hourly). */
async function queryRecentSummaries(
  item: string, primaryField: string, limit: number,
): Promise<AuctionSummaryRow[]> {
  const fields = [primaryField, primaryField === 'base_item' ? 'skyblock_id' : 'base_item'];

  // Try minute summaries first, then hourly
  for (const granularity of ['minute', 'hourly']) {
    for (const field of fields) {
      try {
        const rows = await postgrestSelect<AuctionSummaryRow>({
          table: 'auction_price_summaries',
          query: { [field]: `eq.${item}`, granularity: `eq.${granularity}` },
          order: 'bucket.desc',
          limit,
          select: SUMMARY_SELECT,
        });
        if (rows.length > 0) return rows.reverse();
      } catch { /* continue */ }
    }
  }
  return [];
}

function parseDuration(interval: string): number {
  const match = interval.match(/^(\d+)\s+(hour|hours|day|days)$/);
  if (!match) return 86400000;
  const [, numStr, unit] = match;
  const num = parseInt(numStr ?? '1');
  if (unit === 'hour' || unit === 'hours') return num * 3600000;
  if (unit === 'day' || unit === 'days') return num * 86400000;
  return 86400000;
}
