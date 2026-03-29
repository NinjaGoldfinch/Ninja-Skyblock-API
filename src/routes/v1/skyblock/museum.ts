import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchMuseum } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { HypixelMuseumResponse } from '../../../types/hypixel.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('route:museum');

interface MuseumParams {
  profileUuid: string;
}

export async function museumRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: MuseumParams }>(
    '/v1/skyblock/museum/:profileUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get SkyBlock museum data',
        description: 'Returns raw Hypixel museum data for a profile UUID.',
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
    async (request: FastifyRequest<{ Params: MuseumParams }>) => {
      const profileUuid = request.params.profileUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<HypixelMuseumResponse['members']>('hot', 'museum', profileUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheMuseum(profileUuid).catch((err) => log.error({ err }, 'Background museum refresh failed'));
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheMuseum(profileUuid);
      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCacheMuseum(profileUuid: string): Promise<HypixelMuseumResponse['members']> {
  const response = await fetchMuseum(profileUuid);
  if (!response.members) {
    throw errors.resourceNotFound('museum', profileUuid);
  }
  await cacheSet('hot', 'museum', profileUuid, response.members);
  return response.members;
}
