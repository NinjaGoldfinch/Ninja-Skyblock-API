import Fastify from 'fastify';
import { env } from './config/env.js';
import { AppError } from './utils/errors.js';
import { closeRedis } from './utils/redis.js';
import { logger } from './utils/logger.js';
import { profileRoute } from './routes/v1/skyblock/profile.js';
import { bazaarRoute } from './routes/v1/skyblock/bazaar.js';
import { profilesRoute } from './routes/v1/skyblock/profiles.js';
import { playerAuctionsRoute } from './routes/v1/skyblock/player-auctions.js';
import { auctionsEndedRoute } from './routes/v1/skyblock/auctions-ended.js';
import { playerUuidRoute } from './routes/v1/player/uuid.js';
import { playerUsernameRoute } from './routes/v1/player/username.js';
import { v2ProfileRoute } from './routes/v2/skyblock/profile.js';
import { v2BazaarRoute } from './routes/v2/skyblock/bazaar.js';
import { v2AuctionsRoute } from './routes/v2/skyblock/auctions.js';
import { authPlugin } from './plugins/auth.js';
import { sseRoute } from './routes/v1/events/stream.js';
import { adminKeysRoute } from './routes/v1/admin/keys.js';
import { watchedPlayersRoute } from './routes/v1/admin/watched-players.js';
import { setupWebSocket } from './routes/v1/events/subscribe.js';
import { swaggerPlugin } from './plugins/swagger.js';
import { registerSharedSchemas } from './schemas/common.js';
import { specRoute } from './routes/v1/docs/spec.js';
import { redocRoute } from './routes/v1/docs/redoc.js';

const app = Fastify({
  routerOptions: { ignoreTrailingSlash: true },
  logger: {
    level: env.LOG_LEVEL,
    transport: env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
});

// Global error handler
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) {
    return reply.status(error.status).send({
      success: false,
      error: { code: error.code, message: error.message, status: error.status },
      meta: { timestamp: Date.now() },
    });
  }

  // Fastify validation errors (from JSON Schema)
  const fastifyError = error as { validation?: unknown; message: string };
  if (fastifyError.validation) {
    return reply.status(400).send({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: fastifyError.message, status: 400 },
      meta: { timestamp: Date.now() },
    });
  }

  // Unexpected errors
  logger.error({ err: error }, 'Unhandled error');
  return reply.status(500).send({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
    meta: { timestamp: Date.now() },
  });
});

// OpenAPI + shared schemas
app.register(swaggerPlugin);
registerSharedSchemas(app);

// Auth
app.register(authPlugin);

// v1 routes — raw Hypixel proxy (no processing)
app.register(profileRoute);
app.register(bazaarRoute);
app.register(profilesRoute);
app.register(playerAuctionsRoute);
app.register(auctionsEndedRoute);
app.register(playerUuidRoute);
app.register(playerUsernameRoute);

// v2 routes — computed/processed data
app.register(v2ProfileRoute);
app.register(v2BazaarRoute);
app.register(v2AuctionsRoute);

// Events
app.register(sseRoute);

// Admin
app.register(adminKeysRoute);
app.register(watchedPlayersRoute);

// Docs
app.register(specRoute);
app.register(redocRoute);

// Health check
app.get('/v1/health', {
  schema: {
    tags: ['health'],
    summary: 'Service health check',
    description: 'Returns service status. No authentication required.',
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean', const: true },
          data: {
            type: 'object',
            properties: {
              status: { type: 'string', description: 'Service status.' },
            },
          },
          meta: { $ref: 'response-meta#' },
        },
      },
    },
  },
}, async () => {
  return { success: true, data: { status: 'ok' }, meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() } };
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT }, 'Server started');

    // Attach WebSocket server to the underlying HTTP server
    const httpServer = app.server;
    await setupWebSocket(httpServer);
    logger.info('WebSocket server attached');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    await closeRedis();
    process.exit(1);
  }
};

start();

export { app };
