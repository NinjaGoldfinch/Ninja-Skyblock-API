import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { ProcessedItem, ItemTextureData, TextureType } from '../../../workers/resource-items.js';

interface ItemParams {
  itemId: string;
}

export async function v2ItemsRoute(app: FastifyInstance): Promise<void> {
  // GET /v2/skyblock/items — all items with processed data
  app.get('/v2/skyblock/items', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get all SkyBlock items (processed)',
      description: 'Returns all SkyBlock items with ID, name, tier, category, and NPC sell price. Updated when Hypixel changes item data.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);

    const cached = await cacheGet<ProcessedItem[]>('warm', 'resources', 'items');
    if (cached) {
      return {
        success: true,
        data: { items: cached.data, count: cached.data.length },
        meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
      };
    }

    throw errors.validation('Items data not available yet. The resource worker may not have run.');
  });

  // GET /v2/skyblock/items/textures — compact texture map for all items
  app.get('/v2/skyblock/items/textures', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get item texture map',
      description: 'Returns a compact mapping of item ID to texture data for frontend icon rendering. Includes texture type (vanilla/skull/leather/item_model), material, decoded skin URLs, and RGB color values.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);

    const cached = await cacheGet<Record<string, ItemTextureData & { type: TextureType }>>('warm', 'resources', 'item-textures');
    if (cached) {
      return {
        success: true,
        data: cached.data,
        meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
      };
    }

    throw errors.validation('Item texture data not available yet. The resource worker may not have run.');
  });

  // GET /v2/skyblock/items/:itemId — single item by ID
  app.get<{ Params: ItemParams }>('/v2/skyblock/items/:itemId', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get a SkyBlock item by ID',
      description: 'Returns item details by Hypixel item ID (e.g. HYPERION, WISE_DRAGON_HELMET).',
      params: {
        type: 'object',
        required: ['itemId'],
        properties: {
          itemId: { type: 'string', minLength: 1, description: 'Hypixel item ID in SCREAMING_SNAKE_CASE.' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        404: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest<{ Params: ItemParams }>) => {
    const { itemId } = request.params;
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);

    const cached = await cacheGet<ProcessedItem[]>('warm', 'resources', 'items');
    if (!cached) {
      throw errors.validation('Items data not available yet.');
    }

    const item = cached.data.find((i) => i.id === itemId.toUpperCase());
    if (!item) {
      throw errors.resourceNotFound('item', itemId);
    }

    return {
      success: true,
      data: item,
      meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
    };
  });

  // GET /v2/skyblock/items/lookup/:name — find item ID by display name
  app.get<{ Params: { name: string } }>('/v2/skyblock/items/lookup/:name', {
    schema: {
      tags: ['skyblock'],
      summary: 'Look up item ID by display name',
      description: 'Returns the Hypixel item ID for a display name (e.g. "Hyperion" → HYPERION).',
      params: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, description: 'Item display name.' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        404: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest<{ Params: { name: string } }>) => {
    const { name } = request.params;
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);

    const cached = await cacheGet<Record<string, string>>('warm', 'resources', 'item-name-to-id');
    if (!cached) {
      throw errors.validation('Items data not available yet.');
    }

    const itemId = cached.data[name];
    if (!itemId) {
      throw errors.resourceNotFound('item', name);
    }

    return {
      success: true,
      data: { id: itemId, name },
      meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
    };
  });
}
