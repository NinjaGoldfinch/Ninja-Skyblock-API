import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('player-username');

interface UuidParams {
  uuid: string;
}

interface MojangProfile {
  id: string;
  name: string;
}

export async function playerUsernameRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: UuidParams }>(
    '/v1/player/username/:uuid',
    {
      schema: {
        tags: ['player'],
        summary: 'Get username from UUID',
        description: 'Resolves a Minecraft UUID to a username via the Mojang API. Results are cached.',
        params: {
          type: 'object',
          required: ['uuid'],
          properties: {
            uuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'Minecraft UUID (with or without hyphens).',
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
    async (request: FastifyRequest<{ Params: UuidParams }>) => {
      const uuid = request.params.uuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<MojangProfile>('warm', 'player-username', uuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const startTime = Date.now();
      const response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`);

      if (response.status === 204 || response.status === 404) {
        throw errors.playerNotFound(uuid);
      }

      if (!response.ok) {
        log.error({ status: response.status, uuid }, 'Mojang session API error');
        throw errors.internal(new Error(`Mojang API returned ${response.status}`));
      }

      const raw = await response.json() as { id: string; name: string };
      const data: MojangProfile = { id: raw.id, name: raw.name };
      log.debug({ uuid, username: data.name, duration_ms: Date.now() - startTime }, 'Mojang username lookup');

      await cacheSet('warm', 'player-username', uuid, data);

      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
