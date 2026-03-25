import { getRedis } from '../utils/redis.js';
import { env } from '../config/env.js';
import { CACHE_PREFIX_HOT, CACHE_PREFIX_WARM, STALE_MULTIPLIER } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cache-manager');

export type CacheTier = 'hot' | 'warm';

interface CacheEntry<T> {
  data: T;
  cached_at: number;
}

interface CacheResult<T> {
  data: T;
  cached: boolean;
  cache_age_seconds: number | null;
  stale: boolean;
}

function getPrefix(tier: CacheTier): string {
  return tier === 'hot' ? CACHE_PREFIX_HOT : CACHE_PREFIX_WARM;
}

function getTtl(tier: CacheTier): number {
  return tier === 'hot' ? env.HOT_CACHE_TTL : env.WARM_CACHE_TTL;
}

function buildKey(tier: CacheTier, resource: string, id: string): string {
  return `${getPrefix(tier)}:${resource}:${id}`;
}

export async function cacheGet<T>(tier: CacheTier, resource: string, id: string): Promise<CacheResult<T> | null> {
  const redis = getRedis();
  const key = buildKey(tier, resource, id);
  const raw = await redis.get(key);

  if (!raw) {
    log.trace({ key, hit: false }, 'Cache miss');
    return null;
  }

  const entry = JSON.parse(raw) as CacheEntry<T>;
  const ageSeconds = Math.floor((Date.now() - entry.cached_at) / 1000);
  const ttl = getTtl(tier);
  const stale = ageSeconds > ttl;

  log.trace({ key, hit: true, age_seconds: ageSeconds, stale }, 'Cache hit');
  return {
    data: entry.data,
    cached: true,
    cache_age_seconds: ageSeconds,
    stale,
  };
}

export async function cacheSet<T>(tier: CacheTier, resource: string, id: string, data: T, dataTimestamp?: number): Promise<void> {
  const redis = getRedis();
  const key = buildKey(tier, resource, id);
  const ttl = getTtl(tier);
  const extendedTtl = ttl * STALE_MULTIPLIER;

  const entry: CacheEntry<T> = {
    data,
    cached_at: dataTimestamp ?? Date.now(),
  };

  await redis.set(key, JSON.stringify(entry), 'EX', extendedTtl);
}

export async function cacheSetBulk<T>(tier: CacheTier, resource: string, entries: Array<{ id: string; data: T }>, dataTimestamp?: number): Promise<void> {
  const redis = getRedis();
  const ttl = getTtl(tier);
  const extendedTtl = ttl * STALE_MULTIPLIER;
  const ts = dataTimestamp ?? Date.now();
  const pipeline = redis.pipeline();

  for (const entry of entries) {
    const key = buildKey(tier, resource, entry.id);
    const cacheEntry: CacheEntry<T> = { data: entry.data, cached_at: ts };
    pipeline.set(key, JSON.stringify(cacheEntry), 'EX', extendedTtl);
  }

  await pipeline.exec();
  log.trace({ tier, resource, count: entries.length }, 'Bulk cache set');
}

export async function cacheDelete(tier: CacheTier, resource: string, id: string): Promise<void> {
  const redis = getRedis();
  const key = buildKey(tier, resource, id);
  await redis.del(key);
}
