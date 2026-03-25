import { describe, it, expect, beforeEach } from 'vitest';
import { checkClientRateLimit, enforceClientRateLimit } from '../../../src/services/rate-limiter.js';
import { AppError } from '../../../src/utils/errors.js';
import { getRedis } from '../../../src/utils/redis.js';

// These tests require a running Redis instance

beforeEach(async () => {
  const redis = getRedis();
  const keys = await redis.keys('rate:client:test-*');
  if (keys.length > 0) await redis.del(...keys);
});

describe('checkClientRateLimit', () => {
  it('allows requests under the limit', async () => {
    const result = await checkClientRateLimit('test-allow', 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
  });

  it('decrements remaining on each call', async () => {
    await checkClientRateLimit('test-decrement', 5);
    await checkClientRateLimit('test-decrement', 5);
    const result = await checkClientRateLimit('test-decrement', 5);
    expect(result.remaining).toBe(2);
  });

  it('rejects when limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await checkClientRateLimit('test-exceed', 3);
    }
    const result = await checkClientRateLimit('test-exceed', 3);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('returns reset_seconds > 0', async () => {
    const result = await checkClientRateLimit('test-reset', 10);
    expect(result.reset_seconds).toBeGreaterThan(0);
    expect(result.reset_seconds).toBeLessThanOrEqual(60);
  });
});

describe('enforceClientRateLimit', () => {
  it('does not throw when under limit', async () => {
    await expect(enforceClientRateLimit('test-enforce-ok', 10)).resolves.toBeUndefined();
  });

  it('throws AppError RATE_LIMITED when exceeded', async () => {
    for (let i = 0; i < 2; i++) {
      await enforceClientRateLimit('test-enforce-fail', 2);
    }

    try {
      await enforceClientRateLimit('test-enforce-fail', 2);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('RATE_LIMITED');
      expect((err as AppError).status).toBe(429);
    }
  });
});
