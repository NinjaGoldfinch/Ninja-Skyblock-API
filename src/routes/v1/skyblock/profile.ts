import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchProfile } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { HypixelSkyBlockProfile } from '../../../types/hypixel.js';

interface ProfileParams {
  profileUuid: string;
}

export async function profileRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProfileParams }>(
    '/v1/skyblock/profile/:profileUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get raw SkyBlock profile',
        description: 'Returns raw Hypixel profile data for a profile UUID. No processing or computed fields.',
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
              data: { type: 'object', additionalProperties: true, description: 'Raw Hypixel profile data.' },
              meta: { $ref: 'response-meta#' },
            },
          },
          404: { $ref: 'error-response#' },
          429: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ProfileParams }>) => {
      const profileUuid = request.params.profileUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Cache check
      const cached = await cacheGet<HypixelSkyBlockProfile>('hot', 'raw-profile', profileUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCache(profileUuid).catch(() => {});
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCache(profileUuid);
      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCache(profileUuid: string): Promise<HypixelSkyBlockProfile> {
  const response = await fetchProfile(profileUuid);
  if (!response.profile) {
    throw errors.profileNotFound(profileUuid);
  }
  await cacheSet('hot', 'raw-profile', profileUuid, response.profile);
  return response.profile;
}
