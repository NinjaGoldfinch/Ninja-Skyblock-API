import type { FastifyInstance, FastifyRequest } from 'fastify';
import { postgrestSelect, postgrestInsert } from '../../../services/postgrest-client.js';
import { env } from '../../../config/env.js';
import { errors } from '../../../utils/errors.js';

interface AddPlayerBody {
  player_uuid: string;
}

interface RemovePlayerParams {
  playerUuid: string;
}

interface WatchedPlayerRow {
  id: number;
  player_uuid: string;
  added_by: string;
  created_at: string;
}

export async function watchedPlayersRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/admin/watched-players — list all watched players
  app.get(
    '/v1/admin/watched-players',
    {
      schema: {
        tags: ['admin'],
        summary: 'List watched players',
        description: 'Returns all players being tracked by the profile tracker.',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'object', additionalProperties: true },
              meta: { $ref: 'response-meta#' },
            },
          },
        },
      },
    },
    async () => {
      let rows: WatchedPlayerRow[];
      try {
        rows = await postgrestSelect<WatchedPlayerRow>({
          table: 'watched_players',
          select: 'id,player_uuid,added_by,created_at',
          order: 'created_at.desc',
        });
      } catch {
        rows = [];
      }

      return {
        success: true,
        data: { players: rows, count: rows.length },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // POST /v1/admin/watched-players — add a player to watch list
  app.post<{ Body: AddPlayerBody }>(
    '/v1/admin/watched-players',
    {
      schema: {
        tags: ['admin'],
        summary: 'Add watched player',
        description: 'Adds a player UUID to the profile tracker watch list. Requires internal authentication.',
        body: {
          type: 'object',
          required: ['player_uuid'],
          properties: {
            player_uuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'Minecraft player UUID.',
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
          403: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Body: AddPlayerBody }>) => {
      if (request.clientTier !== 'internal') {
        throw errors.forbidden('Only internal clients can manage watched players.');
      }

      const playerUuid = request.body.player_uuid.replaceAll('-', '');

      try {
        await postgrestInsert('watched_players', {
          player_uuid: playerUuid,
          added_by: request.clientId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('duplicate') || message.includes('unique')) {
          throw errors.validation(`Player ${playerUuid} is already being watched.`);
        }
        throw err;
      }

      return {
        success: true,
        data: { player_uuid: playerUuid, message: 'Player added to watch list.' },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // DELETE /v1/admin/watched-players/:playerUuid — remove a player
  app.delete<{ Params: RemovePlayerParams }>(
    '/v1/admin/watched-players/:playerUuid',
    {
      schema: {
        tags: ['admin'],
        summary: 'Remove watched player',
        description: 'Removes a player from the profile tracker watch list. Requires internal authentication.',
        params: {
          type: 'object',
          required: ['playerUuid'],
          properties: {
            playerUuid: { type: 'string', description: 'Player UUID to remove.' },
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
          403: { $ref: 'error-response#' },
        },
      },
    },
    async (request: FastifyRequest<{ Params: RemovePlayerParams }>) => {
      if (request.clientTier !== 'internal') {
        throw errors.forbidden('Only internal clients can manage watched players.');
      }

      const playerUuid = request.params.playerUuid.replaceAll('-', '');

      // PostgREST DELETE via fetch
      const response = await fetch(
        `${env.POSTGREST_URL}/watched_players?player_uuid=eq.${playerUuid}`,
        { method: 'DELETE' },
      );

      if (!response.ok) {
        throw errors.internal(new Error(`Failed to delete watched player: ${response.status}`));
      }

      return {
        success: true,
        data: { player_uuid: playerUuid, message: 'Player removed from watch list.' },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
