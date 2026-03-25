import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';

export async function resourcesRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/collections
  app.get('/v1/skyblock/collections', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get SkyBlock collections data',
      description: 'Returns all SkyBlock collection requirements and unlocks. Cached from Hypixel resources endpoint.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);
    const cached = await cacheGet<Record<string, unknown>>('warm', 'resources', 'collections');
    if (cached) {
      return { success: true, data: cached.data, meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() } };
    }
    throw errors.validation('Collections data not available yet. The resource worker may not have run.');
  });

  // GET /v1/skyblock/skills
  app.get('/v1/skyblock/skills', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get SkyBlock skills data',
      description: 'Returns all SkyBlock skill XP requirements and unlocks. Cached from Hypixel resources endpoint.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);
    const cached = await cacheGet<Record<string, unknown>>('warm', 'resources', 'skills');
    if (cached) {
      return { success: true, data: cached.data, meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() } };
    }
    throw errors.validation('Skills data not available yet. The resource worker may not have run.');
  });

  // GET /v1/skyblock/items
  app.get('/v1/skyblock/items', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get all SkyBlock items',
      description: 'Returns all SkyBlock items with IDs, names, tiers, and categories. Cached from Hypixel resources endpoint.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);
    const cached = await cacheGet<unknown[]>('warm', 'resources', 'items');
    if (cached) {
      return { success: true, data: { items: cached.data, count: cached.data.length }, meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() } };
    }
    throw errors.validation('Items data not available yet. The resource worker may not have run.');
  });

  // GET /v1/skyblock/election
  app.get('/v1/skyblock/election', {
    schema: {
      tags: ['skyblock'],
      summary: 'Get current mayor and election data',
      description: 'Returns the current SkyBlock mayor, their perks, and any active election. Cached from Hypixel resources endpoint.',
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true }, meta: { $ref: 'response-meta#' } } },
        400: { $ref: 'error-response#' },
      },
    },
  }, async (request: FastifyRequest) => {
    await enforceClientRateLimit(request.clientId, request.clientRateLimit);
    const cached = await cacheGet<Record<string, unknown>>('warm', 'resources', 'election');
    if (cached) {
      return { success: true, data: cached.data, meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() } };
    }
    throw errors.validation('Election data not available yet. The resource worker may not have run.');
  });
}
