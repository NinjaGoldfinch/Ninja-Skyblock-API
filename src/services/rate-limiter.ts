import { getRedis } from '../utils/redis.js';
import { env } from '../config/env.js';
import { RATE_PREFIX_CLIENT, RATE_PREFIX_HYPIXEL } from '../config/constants.js';
import { errors } from '../utils/errors.js';
import { createHash } from 'node:crypto';

const WINDOW_SECONDS = 60;

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  reset_seconds: number;
}

async function checkRateLimit(key: string, limit: number): Promise<RateLimitResult> {
  const redis = getRedis();
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  const ttl = await redis.ttl(key);
  const resetSeconds = ttl > 0 ? ttl : WINDOW_SECONDS;

  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
    limit,
    reset_seconds: resetSeconds,
  };
}

export async function checkClientRateLimit(clientId: string): Promise<RateLimitResult> {
  const key = `${RATE_PREFIX_CLIENT}:${clientId}`;
  return checkRateLimit(key, env.CLIENT_RATE_LIMIT);
}

export async function checkHypixelRateLimit(apiKey: string): Promise<RateLimitResult> {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
  const key = `${RATE_PREFIX_HYPIXEL}:${keyHash}`;
  return checkRateLimit(key, env.HYPIXEL_RATE_LIMIT);
}

export async function enforceClientRateLimit(clientId: string): Promise<void> {
  const result = await checkClientRateLimit(clientId);
  if (!result.allowed) {
    throw errors.rateLimited();
  }
}

export async function canCallHypixel(apiKey: string): Promise<boolean> {
  const result = await checkHypixelRateLimit(apiKey);
  return result.allowed;
}
