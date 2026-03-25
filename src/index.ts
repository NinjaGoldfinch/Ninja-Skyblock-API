import Fastify from 'fastify';
import { env } from './config/env.js';
import { AppError } from './utils/errors.js';
import { closeRedis } from './utils/redis.js';
import { logger } from './utils/logger.js';
import { profileRoute } from './routes/v1/skyblock/profile.js';
import { bazaarRoute } from './routes/v1/skyblock/bazaar.js';
import { authPlugin } from './plugins/auth.js';
import { startBazaarTracker } from './workers/bazaar-tracker.js';
import { closeQueues } from './utils/queue.js';
import { sseRoute } from './routes/v1/events/stream.js';
import { adminKeysRoute } from './routes/v1/admin/keys.js';
import { setupWebSocket } from './routes/v1/events/subscribe.js';
import { closeEventBus } from './services/event-bus.js';

const app = Fastify({
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

// Auth
app.register(authPlugin);

// Routes
app.register(profileRoute);
app.register(bazaarRoute);
app.register(sseRoute);
app.register(adminKeysRoute);

// Health check
app.get('/v1/health', async () => {
  return { success: true, data: { status: 'ok' }, meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() } };
});

const start = async () => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT }, 'Server started');

    // Start background workers
    startBazaarTracker();
    logger.info('Bazaar tracker started');

    // Attach WebSocket server to the underlying HTTP server
    const httpServer = app.server;
    await setupWebSocket(httpServer);
    logger.info('WebSocket server attached');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    await closeQueues();
    await closeEventBus();
    await closeRedis();
    process.exit(1);
  }
};

start();

export { app };
