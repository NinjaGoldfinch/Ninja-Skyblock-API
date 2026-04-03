import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../../src/utils/errors.js';
import { registerSharedSchemas } from '../../../src/schemas/common.js';

// Mock external dependencies before importing the route
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockFetchProfile = vi.fn();
const mockEnforceClientRateLimit = vi.fn();

vi.mock('../../../src/services/cache-manager.js', () => ({
  cacheGet: (...args: unknown[]) => mockCacheGet(...args),
  cacheSet: (...args: unknown[]) => mockCacheSet(...args),
}));

vi.mock('../../../src/services/hypixel-client.js', () => ({
  fetchProfile: (...args: unknown[]) => mockFetchProfile(...args),
}));

vi.mock('../../../src/services/rate-limiter.js', () => ({
  enforceClientRateLimit: (...args: unknown[]) => mockEnforceClientRateLimit(...args),
}));

vi.mock('../../../src/config/env.js', () => ({
  env: {
    HMAC_SECRET: 'test-secret',
    DEV_AUTH_BYPASS: true,
    CLIENT_RATE_LIMIT: 60,
    PUBLIC_RATE_LIMIT: 30,
    PORT: 3000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    HOT_CACHE_TTL: 60,
    WARM_CACHE_TTL: 300,
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { authPlugin } from '../../../src/plugins/auth.js';
import { profileRoute } from '../../../src/routes/v1/skyblock/profile.js';

const VALID_UUID = '2b184964a4064f00ab7dd7dda51275f7';
const VALID_UUID_HYPHENATED = '2b184964-a406-4f00-ab7d-d7dda51275f7';

const sampleProfile = {
  profile_id: VALID_UUID,
  cute_name: 'Strawberry',
  members: { 'abc123': { experience_skill_mining: 1000 } },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  registerSharedSchemas(app);
  app.register(authPlugin);
  app.register(profileRoute);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockEnforceClientRateLimit.mockResolvedValue(undefined);
  mockCacheSet.mockResolvedValue(undefined);
});

describe('GET /v1/skyblock/profile/:profileUuid', () => {
  // --- Validation ---

  it('rejects invalid UUID format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/skyblock/profile/not-a-valid-uuid',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('accepts hyphenated UUID', async () => {
    mockCacheGet.mockResolvedValueOnce({ data: sampleProfile, stale: false, cache_age_seconds: 5 });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID_HYPHENATED}`,
    });
    expect(res.statusCode).toBe(200);
  });

  // --- Cache hit (fresh) ---

  it('returns cached data when cache is fresh', async () => {
    mockCacheGet.mockResolvedValueOnce({ data: sampleProfile, stale: false, cache_age_seconds: 10 });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(sampleProfile);
    expect(body.meta.cached).toBe(true);
    expect(body.meta.cache_age_seconds).toBe(10);
    // Should NOT have called Hypixel
    expect(mockFetchProfile).not.toHaveBeenCalled();
  });

  // --- Cache hit (stale) ---

  it('returns stale cache and triggers background refresh', async () => {
    mockCacheGet.mockResolvedValueOnce({ data: sampleProfile, stale: true, cache_age_seconds: 120 });
    // Background refresh will call fetchProfile — mock it to succeed
    mockFetchProfile.mockResolvedValueOnce({ profile: { ...sampleProfile, cute_name: 'Updated' } });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.meta.cached).toBe(true);
    expect(body.meta.cache_age_seconds).toBe(120);
    // Returns stale data immediately
    expect(body.data).toEqual(sampleProfile);
  });

  // --- Cache miss ---

  it('fetches from Hypixel on cache miss', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockFetchProfile.mockResolvedValueOnce({ profile: sampleProfile });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(sampleProfile);
    expect(body.meta.cached).toBe(false);
    expect(body.meta.cache_age_seconds).toBeNull();
    expect(mockFetchProfile).toHaveBeenCalledWith(VALID_UUID);
  });

  it('caches fetched profile data', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockFetchProfile.mockResolvedValueOnce({ profile: sampleProfile });

    await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(mockCacheSet).toHaveBeenCalledWith('hot', 'raw-profile', VALID_UUID, sampleProfile);
  });

  // --- Profile not found ---

  it('returns 404 when Hypixel returns null profile', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockFetchProfile.mockResolvedValueOnce({ profile: null });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PROFILE_NOT_FOUND');
  });

  // --- Rate limiting ---

  it('returns 429 when rate limited', async () => {
    mockEnforceClientRateLimit.mockRejectedValueOnce(
      new AppError('RATE_LIMITED', 429, 'Rate limit exceeded. Try again shortly.'),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  // --- Hypixel error propagation ---

  it('returns 502 when Hypixel API errors', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockFetchProfile.mockRejectedValueOnce(
      new AppError('HYPIXEL_API_ERROR', 502, 'Hypixel API returned an error.'),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID}`,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('HYPIXEL_API_ERROR');
  });

  // --- UUID normalization ---

  it('strips hyphens before cache lookup and fetch', async () => {
    mockCacheGet.mockResolvedValueOnce(null);
    mockFetchProfile.mockResolvedValueOnce({ profile: sampleProfile });

    await app.inject({
      method: 'GET',
      url: `/v1/skyblock/profile/${VALID_UUID_HYPHENATED}`,
    });

    // Cache and fetch should use stripped UUID
    expect(mockCacheGet).toHaveBeenCalledWith('hot', 'raw-profile', VALID_UUID);
    expect(mockFetchProfile).toHaveBeenCalledWith(VALID_UUID);
  });
});
