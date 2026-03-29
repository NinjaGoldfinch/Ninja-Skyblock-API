import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fetchBingo, fetchBingoGoals } from '../../../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../../../services/cache-manager.js';
import { enforceClientRateLimit } from '../../../services/rate-limiter.js';
import { errors } from '../../../utils/errors.js';
import type { HypixelBingoResponse, HypixelBingoGoalsResponse } from '../../../types/hypixel.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('route:bingo');

interface BingoParams {
  playerUuid: string;
}

export async function bingoRoute(app: FastifyInstance): Promise<void> {
  // GET /v1/skyblock/bingo/goals — public bingo goals resource
  app.get(
    '/v1/skyblock/bingo/goals',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get bingo goals',
        description: 'Returns current bingo event goals. Public endpoint, no API key required.',
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
    async (request: FastifyRequest) => {
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<HypixelBingoGoalsResponse>('warm', 'bingo-goals', 'latest');
      if (cached && !cached.stale) {
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheBingoGoals().catch((err) => log.error({ err }, 'Background bingo goals refresh failed'));
        return {
          success: true,
          data: cached.data,
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheBingoGoals();
      return {
        success: true,
        data,
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );

  // GET /v1/skyblock/bingo/:playerUuid — player bingo data (requires API key)
  app.get<{ Params: BingoParams }>(
    '/v1/skyblock/bingo/:playerUuid',
    {
      schema: {
        tags: ['skyblock'],
        summary: 'Get player bingo data',
        description: 'Returns bingo event data for a player UUID.',
        params: {
          type: 'object',
          required: ['playerUuid'],
          properties: {
            playerUuid: {
              type: 'string',
              pattern: '^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12}$',
              description: 'Player UUID (with or without hyphens).',
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
    async (request: FastifyRequest<{ Params: BingoParams }>) => {
      const playerUuid = request.params.playerUuid.replaceAll('-', '');
      await enforceClientRateLimit(request.clientId, request.clientRateLimit);

      const cached = await cacheGet<HypixelBingoResponse['events']>('hot', 'bingo', playerUuid);
      if (cached && !cached.stale) {
        return {
          success: true,
          data: { events: cached.data },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      if (cached && cached.stale) {
        fetchAndCacheBingo(playerUuid).catch((err) => log.error({ err }, 'Background bingo refresh failed'));
        return {
          success: true,
          data: { events: cached.data },
          meta: { cached: true, cache_age_seconds: cached.cache_age_seconds, timestamp: Date.now() },
        };
      }

      const data = await fetchAndCacheBingo(playerUuid);
      return {
        success: true,
        data: { events: data },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}

async function fetchAndCacheBingoGoals(): Promise<HypixelBingoGoalsResponse> {
  const response = await fetchBingoGoals();
  await cacheSet('warm', 'bingo-goals', 'latest', response);
  return response;
}

async function fetchAndCacheBingo(playerUuid: string): Promise<HypixelBingoResponse['events']> {
  const response = await fetchBingo(playerUuid);
  if (!response.events) {
    throw errors.resourceNotFound('bingo', playerUuid);
  }
  await cacheSet('hot', 'bingo', playerUuid, response.events);
  return response.events;
}
