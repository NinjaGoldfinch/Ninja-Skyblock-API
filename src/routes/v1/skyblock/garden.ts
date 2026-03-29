import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchGarden } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('route:garden');

interface GardenParams {
  profileUuid: string;
}

export async function gardenRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: GardenParams }>(
    '/v1/skyblock/garden/:profileUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get SkyBlock garden data',
        description: 'Returns raw Hypixel garden data for a profile UUID.',
        params: {
          type: 'object',
          required: ['profileUuid'],
          properties: {
            profileUuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'SkyBlock profile UUID (with or without hyphens).',
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
    async (request: FastifyRequest<{ Params: GardenParams }>) => {
      const profileUuid = request.params.profileUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<Record<string, unknown>>('hot', 'garden', profileUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheGarden(profileUuid).catch((err) => log.error({ err }, 'Background garden refresh failed'));
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheGarden(profileUuid);
      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCacheGarden(profileUuid: string): Promise<Record<string, unknown>> {
  const response = await fetchGarden(profileUuid);
  if (!response.garden) {
    throw errors.resourceNotFound('garden', profileUuid);
  }
  await cacheSet('hot', 'garden', profileUuid, response.garden);
  return response.garden;
}
