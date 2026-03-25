function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    process.stderr.write(`FATAL: Missing required environment variable: ${key}\n`);
    process.exit(1);
  }
  return value;
}

export const env = {
  // Server
  PORT:                  parseInt(process.env['PORT'] ?? '3000'),
  NODE_ENV:              process.env['NODE_ENV'] ?? 'development',
  LOG_LEVEL:             process.env['LOG_LEVEL'] ?? 'info',

  // Redis
  REDIS_URL:             requireEnv('REDIS_URL'),

  // PostgREST
  POSTGREST_URL:         requireEnv('POSTGREST_URL'),

  // Hypixel
  HYPIXEL_API_KEY:       requireEnv('HYPIXEL_API_KEY'),

  // Auth
  HMAC_SECRET:           requireEnv('HMAC_SECRET'),

  // Rate limits (overridable, sensible defaults)
  CLIENT_RATE_LIMIT:     parseInt(process.env['CLIENT_RATE_LIMIT'] ?? '60'),
  PUBLIC_RATE_LIMIT:     parseInt(process.env['PUBLIC_RATE_LIMIT'] ?? '30'),
  HYPIXEL_RATE_LIMIT:    parseInt(process.env['HYPIXEL_RATE_LIMIT'] ?? '120'),

  // Cache TTLs (seconds)
  HOT_CACHE_TTL:         parseInt(process.env['HOT_CACHE_TTL'] ?? '60'),
  WARM_CACHE_TTL:        parseInt(process.env['WARM_CACHE_TTL'] ?? '300'),

  // Worker intervals (milliseconds)
  BAZAAR_POLL_INTERVAL:  parseInt(process.env['BAZAAR_POLL_INTERVAL'] ?? '60000'),
  AUCTION_POLL_INTERVAL: parseInt(process.env['AUCTION_POLL_INTERVAL'] ?? '45000'),
  PROFILE_POLL_INTERVAL: parseInt(process.env['PROFILE_POLL_INTERVAL'] ?? '300000'),
} as const;
