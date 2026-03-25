import type { FastifyInstance } from 'fastify';

export function registerSharedSchemas(app: FastifyInstance): void {
  app.addSchema({
    $id: 'response-meta',
    type: 'object',
    description: 'Metadata about the response, including cache status and timing.',
    properties: {
      cached: { type: 'boolean', description: 'Whether this response was served from Redis cache.' },
      cache_age_seconds: {
        type: ['number', 'null'],
        description: 'How many seconds ago the cached data was fetched from Hypixel. `null` if this is a fresh (non-cached) response.',
      },
      timestamp: { type: 'number', description: 'Unix timestamp in milliseconds when the response was generated.' },
    },
  });

  app.addSchema({
    $id: 'error-object',
    type: 'object',
    description: 'Structured error information. The `code` field is machine-readable and stable across versions.',
    properties: {
      code: {
        type: 'string',
        description: 'Machine-readable error code. Use this for programmatic error handling.',
        enum: [
          'VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN',
          'PLAYER_NOT_FOUND', 'PROFILE_NOT_FOUND', 'RESOURCE_NOT_FOUND',
          'RATE_LIMITED', 'HYPIXEL_API_ERROR', 'HYPIXEL_RATE_LIMITED',
          'HYPIXEL_UNAVAILABLE', 'INTERNAL_ERROR',
        ],
      },
      message: { type: 'string', description: 'Human-readable error description. Do not parse this — use `code` instead.' },
      status: { type: 'integer', description: 'HTTP status code (mirrors the response status).' },
    },
  });

  app.addSchema({
    $id: 'error-response',
    type: 'object',
    properties: {
      success: { type: 'boolean', const: false },
      error: { $ref: 'error-object#' },
      meta: {
        type: 'object',
        properties: {
          timestamp: { type: 'number' },
        },
      },
    },
  });
}
