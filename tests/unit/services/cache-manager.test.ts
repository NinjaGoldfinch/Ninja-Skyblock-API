import { describe, it, expect, beforeEach } from 'vitest';
import { cacheGet, cacheSet, cacheSetBulk, cacheDelete } from '../../../src/services/cache-manager.js';
import { getRedis } from '../../../src/utils/redis.js';

// These tests require a running Redis instance

beforeEach(async () => {
  const redis = getRedis();
  // Clean test keys
  const keys = await redis.keys('cache:*:test:*');
  if (keys.length > 0) await redis.del(...keys);
});

describe('cacheSet + cacheGet', () => {
  it('stores and retrieves data', async () => {
    await cacheSet('hot', 'test', 'item1', { name: 'test' });
    const result = await cacheGet<{ name: string }>('hot', 'test', 'item1');

    expect(result).not.toBeNull();
    expect(result!.data.name).toBe('test');
    expect(result!.cached).toBe(true);
    expect(result!.cache_age_seconds).toBeGreaterThanOrEqual(0);
    expect(result!.stale).toBe(false);
  });

  it('returns null for missing key', async () => {
    const result = await cacheGet('hot', 'test', 'nonexistent');
    expect(result).toBeNull();
  });

  it('uses correct key prefix for hot tier', async () => {
    await cacheSet('hot', 'test', 'hotitem', { v: 1 });
    const redis = getRedis();
    const raw = await redis.get('cache:hot:test:hotitem');
    expect(raw).not.toBeNull();
  });

  it('uses correct key prefix for warm tier', async () => {
    await cacheSet('warm', 'test', 'warmitem', { v: 1 });
    const redis = getRedis();
    const raw = await redis.get('cache:warm:test:warmitem');
    expect(raw).not.toBeNull();
  });
});

describe('cacheSetBulk', () => {
  it('sets multiple keys in one pipeline', async () => {
    const entries = [
      { id: 'bulk1', data: { v: 1 } },
      { id: 'bulk2', data: { v: 2 } },
      { id: 'bulk3', data: { v: 3 } },
    ];

    await cacheSetBulk('warm', 'test', entries);

    const r1 = await cacheGet<{ v: number }>('warm', 'test', 'bulk1');
    const r2 = await cacheGet<{ v: number }>('warm', 'test', 'bulk2');
    const r3 = await cacheGet<{ v: number }>('warm', 'test', 'bulk3');

    expect(r1!.data.v).toBe(1);
    expect(r2!.data.v).toBe(2);
    expect(r3!.data.v).toBe(3);
  });
});

describe('cacheDelete', () => {
  it('removes a cached key', async () => {
    await cacheSet('hot', 'test', 'deleteme', { v: 1 });
    const before = await cacheGet('hot', 'test', 'deleteme');
    expect(before).not.toBeNull();

    await cacheDelete('hot', 'test', 'deleteme');
    const after = await cacheGet('hot', 'test', 'deleteme');
    expect(after).toBeNull();
  });
});
