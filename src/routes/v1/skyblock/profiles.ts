import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchPlayerProfiles } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';

interface ProfilesParams {
  playerUuid: string;
}

interface ProfileSummary {
  profile_id: string;
  cute_name: string;
  selected: boolean;
  members: number;
}

export async function profilesRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: ProfilesParams }>(
    '/v1/skyblock/profiles/:playerUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'List all SkyBlock profiles for a player',
        description: 'Returns all SkyBlock profiles for a player UUID, with profile IDs, names, and selection status. Use the profile ID to query the full profile endpoint.',
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
    async (request: FastifyRequest<{ Params: ProfilesParams }>) => {
      const playerUuid = request.params.playerUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Check cache
      const cached = await cacheGet<ProfileSummary[]>('hot', 'profiles', playerUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { player_uuid: playerUuid, profiles: cached.data },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Fetch from Hypixel
      const response = await fetchPlayerProfiles(playerUuid);
      if (!response.profiles || response.profiles.length === 0) {
        throw errors.playerNotFound(playerUuid);
      }

      const profiles: ProfileSummary[] = response.profiles.map((p) => ({
        profile_id: p.profile_id,
        cute_name: p.cute_name,
        selected: p.selected,
        members: Object.keys(p.members).length,
      }));

      await cacheSet('hot', 'profiles', playerUuid, profiles);

      return {
        success: true,
        data: { player_uuid: playerUuid, profiles },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
