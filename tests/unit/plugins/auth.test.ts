import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';

vi.mock('../../../src/config/env.js', () => ({
  env: {
    HMAC_SECRET: 'test-hmac-secret-key',
    DEV_AUTH_BYPASS: false,
    CLIENT_RATE_LIMIT: 60,
    PUBLIC_RATE_LIMIT: 30,
    PORT: 3000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
  },
}));

const TEST_HMAC_SECRET = 'test-hmac-secret-key';
const CLIENT_RATE_LIMIT = 60;
const PUBLIC_RATE_LIMIT = 30;

vi.mock('../../../src/services/api-key-manager.js', () => ({
  validateApiKey: vi.fn(),
}));

import { authPlugin } from '../../../src/plugins/auth.js';
import { validateApiKey } from '../../../src/services/api-key-manager.js';

const mockValidateApiKey = vi.mocked(validateApiKey);

function makeHmacSignature(timestamp: string, body: string): string {
  return createHmac('sha256', TEST_HMAC_SECRET)
    .update(`${timestamp}${body}`)
    .digest('hex');
}

// Helper to build a Fastify app with auth + a test route that exposes auth state
async function buildApp(overrides?: { DEV_AUTH_BYPASS?: boolean }): Promise<FastifyInstance> {
  if (overrides?.DEV_AUTH_BYPASS !== undefined) {
    const { env } = await import('../../../src/config/env.js');
    (env as Record<string, unknown>).DEV_AUTH_BYPASS = overrides.DEV_AUTH_BYPASS;
  }

  const app = Fastify();
  await app.register(authPlugin);

  const authResponse = async (request: import('fastify').FastifyRequest) => ({
    clientId: request.clientId,
    clientTier: request.clientTier,
    clientRateLimit: request.clientRateLimit,
  });

  // Private routes
  app.get('/v1/admin/test', authResponse);
  app.post('/v1/admin/test', authResponse);

  // Public routes
  app.get('/v1/skyblock/bazaar', authResponse);
  app.get('/v1/skyblock/bazaar/history', authResponse);

  // Anonymous routes
  app.get('/v1/health', authResponse);
  app.get('/v1/events/subscribe', authResponse);

  await app.ready();
  return app;
}

describe('authPlugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Anonymous routes (health, events) ---

  describe('anonymous routes', () => {
    it('/v1/health returns anonymous access', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.clientId).toBe('anonymous');
      expect(body.clientTier).toBe('anonymous');
      expect(body.clientRateLimit).toBe(CLIENT_RATE_LIMIT);
    });

    it('/v1/events/subscribe returns anonymous access', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/events/subscribe' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.clientId).toBe('anonymous');
      expect(body.clientTier).toBe('anonymous');
    });

    it('/v1/health with query params still matches', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/health?check=true' });
      expect(res.statusCode).toBe(200);
      expect(res.json().clientId).toBe('anonymous');
    });
  });

  // --- HMAC authentication ---

  describe('HMAC authentication', () => {
    it('valid HMAC signature grants internal access', async () => {
      const timestamp = String(Date.now());
      const body = '';
      const signature = makeHmacSignature(timestamp, body);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-signature': signature, 'x-timestamp': timestamp },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.clientId).toBe('hmac-client');
      expect(json.clientTier).toBe('internal');
      expect(json.clientRateLimit).toBe(CLIENT_RATE_LIMIT);
    });

    it('valid HMAC on POST succeeds (body not yet parsed in onRequest)', async () => {
      const timestamp = String(Date.now());
      // onRequest runs before body parsing — request.body is undefined,
      // so auth uses empty string for HMAC payload
      const signature = makeHmacSignature(timestamp, '');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/test',
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'content-type': 'application/json',
        },
        payload: { key: 'value' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().clientId).toBe('hmac-client');
    });

    it('rejects missing x-signature + x-timestamp on private route', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/test' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects invalid HMAC signature', async () => {
      const timestamp = String(Date.now());
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-signature': 'deadbeef'.repeat(8), 'x-timestamp': timestamp },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects non-integer timestamp', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-signature': 'abc123', 'x-timestamp': 'not-a-number' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects timestamp too far in the past (>5 minutes)', async () => {
      const oldTimestamp = String(Date.now() - 6 * 60 * 1000); // 6 minutes ago
      const signature = makeHmacSignature(oldTimestamp, '');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-signature': signature, 'x-timestamp': oldTimestamp },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts timestamp within 5-minute window', async () => {
      const recentTimestamp = String(Date.now() - 4 * 60 * 1000); // 4 minutes ago
      const signature = makeHmacSignature(recentTimestamp, '');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-signature': signature, 'x-timestamp': recentTimestamp },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().clientId).toBe('hmac-client');
    });
  });

  // --- API key authentication ---

  describe('API key authentication', () => {
    it('valid API key sets owner tier and rate limit', async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        owner: 'test-user',
        tier: 'premium',
        rate_limit: 120,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-api-key': 'nsa_test123' },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.clientId).toBe('apikey:test-user');
      expect(json.clientTier).toBe('premium');
      expect(json.clientRateLimit).toBe(120);
      expect(mockValidateApiKey).toHaveBeenCalledWith('nsa_test123');
    });

    it('invalid API key returns 401', async () => {
      mockValidateApiKey.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: { 'x-api-key': 'nsa_invalid' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // --- Public routes ---

  describe('public routes', () => {
    it('public route without auth uses IP-based access', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/skyblock/bazaar' });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.clientId).toMatch(/^ip:/);
      expect(json.clientTier).toBe('public');
      expect(json.clientRateLimit).toBe(PUBLIC_RATE_LIMIT);
    });

    it('public subpath without auth uses IP-based access', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/skyblock/bazaar/history' });
      expect(res.statusCode).toBe(200);
      expect(res.json().clientTier).toBe('public');
    });

    it('rejects partial prefix match (not a real public route)', async () => {
      // /v1/skyblock/bazaarX should NOT match /v1/skyblock/bazaar
      // This hits the private "no auth" path → 401
      const res = await app.inject({ method: 'GET', url: '/v1/skyblock/bazaarX' });
      // Route doesn't exist, but auth runs first — should be 401 since not public
      expect(res.statusCode).toBe(401);
    });
  });

  // --- Private route without auth ---

  describe('private route rejection', () => {
    it('private route without any auth returns 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/test' });
      expect(res.statusCode).toBe(401);
    });
  });

  // --- HMAC takes priority over API key ---

  describe('auth priority', () => {
    it('HMAC header takes priority over API key header', async () => {
      const timestamp = String(Date.now());
      const signature = makeHmacSignature(timestamp, '');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/test',
        headers: {
          'x-signature': signature,
          'x-timestamp': timestamp,
          'x-api-key': 'nsa_should_be_ignored',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().clientId).toBe('hmac-client');
      expect(mockValidateApiKey).not.toHaveBeenCalled();
    });
  });
});

describe('authPlugin with DEV_AUTH_BYPASS', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ DEV_AUTH_BYPASS: true });
  });

  afterAll(async () => {
    // Restore to false for other test suites
    const { env } = await import('../../../src/config/env.js');
    (env as Record<string, unknown>).DEV_AUTH_BYPASS = false;
    await app.close();
  });

  it('bypasses auth on private routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/test' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.clientId).toBe('dev-bypass');
    expect(json.clientTier).toBe('internal');
    expect(json.clientRateLimit).toBe(CLIENT_RATE_LIMIT);
  });
});
