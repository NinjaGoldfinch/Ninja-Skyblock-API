import { getRedis } from '../utils/redis.js';
import { env } from '../config/env.js';
import { CACHE_PREFIX_HOT, CACHE_PREFIX_WARM, STALE_MULTIPLIER } from '../config/constants.js';

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
    return null;
  }

  const entry = JSON.parse(raw) as CacheEntry<T>;
  const ageSeconds = Math.floor((Date.now() - entry.cached_at) / 1000);
  const ttl = getTtl(tier);
  const stale = ageSeconds > ttl;

  return {
    data: entry.data,
    cached: true,
    cache_age_seconds: ageSeconds,
    stale,
  };
}

export async function cacheSet<T>(tier: CacheTier, resource: string, id: string, data: T): Promise<void> {
  const redis = getRedis();
  const key = buildKey(tier, resource, id);
  const ttl = getTtl(tier);

  // Store with extended TTL so stale-while-revalidate can serve stale data
  const extendedTtl = ttl * STALE_MULTIPLIER;

  const entry: CacheEntry<T> = {
    data,
    cached_at: Date.now(),
  };

  await redis.set(key, JSON.stringify(entry), 'EX', extendedTtl);
}

export async function cacheDelete(tier: CacheTier, resource: string, id: string): Promise<void> {
  const redis = getRedis();
  const key = buildKey(tier, resource, id);
  await redis.del(key);
}
