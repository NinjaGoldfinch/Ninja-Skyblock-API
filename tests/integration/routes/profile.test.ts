import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../../src/plugins/auth.js';
import { profileRoute } from '../../../src/routes/v1/skyblock/profile.js';
import { AppError } from '../../../src/utils/errors.js';
import { registerSharedSchemas } from '../../../src/schemas/common.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env['DEV_AUTH_BYPASS'] = 'true';
  app = Fastify();
  registerSharedSchemas(app);
  app.register(authPlugin);
  app.register(profileRoute);

  // Global error handler matching index.ts
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        success: false,
        error: { code: error.code, message: error.message, status: error.status },
        meta: { timestamp: Date.now() },
      });
    }
    const fastifyError = error as { validation?: unknown; message: string };
    if (fastifyError.validation) {
      return reply.status(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: fastifyError.message, status: 400 },
        meta: { timestamp: Date.now() },
      });
    }
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
      meta: { timestamp: Date.now() },
    });
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/skyblock/profile/:profileUuid', () => {
  it('rejects invalid UUID format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/not-a-valid-uuid',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts hyphenated UUID format', async () => {
    // This will fail at Hypixel (test key), but should pass validation
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/2b184964-a406-4f00-ab7d-d7dda51275f7',
    });
    // Should not be 400 (validation passes)
    expect(res.statusCode).not.toBe(400);
  });

  it('accepts non-hyphenated UUID format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/2b184964a4064f00ab7dd7dda51275f7',
    });
    expect(res.statusCode).not.toBe(400);
  });

  it('returns error envelope on upstream failure', async () => {
    // With a fake API key, Hypixel will return an error
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/00000000000000000000000000000000',
    });
    // Should be a proper error envelope, not a raw crash
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
    expect(body.meta).toBeDefined();
  });
});
