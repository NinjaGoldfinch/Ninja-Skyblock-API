import { randomBytes, createHash } from 'node:crypto';
import { postgrestSelect, postgrestInsert } from './postgrest-client.js';

export interface ApiKeyRecord {
  id: number;
  key_hash: string;
  key_prefix: string;
  owner: string;
  tier: string;
  rate_limit: number;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface ApiKeyInfo {
  owner: string;
  tier: string;
  rate_limit: number;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a new API key. Returns the raw key (shown once to the user)
 * and stores the hash in Postgres.
 */
export async function generateApiKey(owner: string, tier = 'public', rateLimit = 30): Promise<string> {
  const rawKey = `nsa_${randomBytes(24).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8);

  await postgrestInsert('api_keys', {
    key_hash: keyHash,
    key_prefix: keyPrefix,
    owner,
    tier,
    rate_limit: rateLimit,
    active: true,
  });

  return rawKey;
}

/**
 * Validate an API key. Returns key info if valid, null if not found or inactive.
 */
export async function validateApiKey(rawKey: string): Promise<ApiKeyInfo | null> {
  const keyHash = hashKey(rawKey);

  let rows: ApiKeyRecord[];
  try {
    rows = await postgrestSelect<ApiKeyRecord>({
      table: 'api_keys',
      query: {
        key_hash: `eq.${keyHash}`,
        active: 'eq.true',
      },
      select: 'owner,tier,rate_limit',
      limit: 1,
    });
  } catch {
    return null;
  }

  if (rows.length === 0) return null;

  const record = rows[0]!;
  return {
    owner: record.owner,
    tier: record.tier,
    rate_limit: record.rate_limit,
  };
}
