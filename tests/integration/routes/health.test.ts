import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../../../src/plugins/auth.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env['DEV_AUTH_BYPASS'] = 'true';
  app = Fastify();
  app.register(authPlugin);
  app.get('/v1/health', async () => {
    return { success: true, data: { status: 'ok' }, meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() } };
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/health', () => {
  it('returns success envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.meta.cached).toBe(false);
    expect(body.meta.timestamp).toBeGreaterThan(0);
  });

  it('does not require authentication', async () => {
    process.env['DEV_AUTH_BYPASS'] = 'false';
    // Health should still work even with auth bypass off since it's excluded
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    process.env['DEV_AUTH_BYPASS'] = 'true';
  });
});
