import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('player-uuid');

interface UsernameParams {
  username: string;
}

interface MojangProfile {
  id: string;
  name: string;
}

export async function playerUuidRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: UsernameParams }>(
    '/v1/player/uuid/:username',
    {
      schema: {
        tags: ['player'],
        summary: 'Get UUID from username',
        description: 'Resolves a Minecraft username to a UUID via the Mojang API. Results are cached.',
        params: {
          type: 'object',
          required: ['username'],
          properties: {
            username: {
              type: 'string',
              minLength: 1,
              maxLength: 16,
              description: 'Minecraft username (1-16 characters).',
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
    async (request: FastifyRequest<{ Params: UsernameParams }>) => {
      const { username } = request.params;
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      // Check cache (warm tier — usernames don't change often)
      const cached = await cacheGet<MojangProfile>('warm', 'player-uuid', username.toLowerCase());
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      // Fetch from Mojang API
      const startTime = Date.now();
      const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`);

      if (response.status === 204 || response.status === 404) {
        throw errors.playerNotFound(username);
      }

      if (!response.ok) {
        log.error({ status: response.status, username }, 'Mojang API error');
        throw errors.internal(new Error(`Mojang API returned ${response.status}`));
      }

      const data = await response.json() as MojangProfile;
      log.debug({ username, uuid: data.id, duration_ms: Date.now() - startTime }, 'Mojang UUID lookup');

      await cacheSet('warm', 'player-uuid', username.toLowerCase(), data);

      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
