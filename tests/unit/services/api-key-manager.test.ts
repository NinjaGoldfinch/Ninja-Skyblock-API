import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPostgrestSelect = vi.fn();
const mockPostgrestInsert = vi.fn();

vi.mock('../../../src/services/postgrest-client.js', () => ({
  postgrestSelect: (...args: unknown[]) => mockPostgrestSelect(...args),
  postgrestInsert: (...args: unknown[]) => mockPostgrestInsert(...args),
}));

import { generateApiKey, validateApiKey } from '../../../src/services/api-key-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateApiKey', () => {
  it('returns a key with nsa_ prefix', async () => {
    mockPostgrestInsert.mockResolvedValueOnce(undefined);
    const key = await generateApiKey('test-owner');
    expect(key).toMatch(/^nsa_[a-f0-9]{48}$/);
  });

  it('inserts key hash into api_keys table', async () => {
    mockPostgrestInsert.mockResolvedValueOnce(undefined);
    await generateApiKey('alice', 'premium', 120);

    expect(mockPostgrestInsert).toHaveBeenCalledWith('api_keys', expect.objectContaining({
      owner: 'alice',
      tier: 'premium',
      rate_limit: 120,
      active: true,
      key_prefix: expect.stringMatching(/^nsa_/),
      key_hash: expect.stringMatching(/^[a-f0-9]{64}$/), // SHA-256 hex
    }));
  });

  it('uses default tier and rate limit', async () => {
    mockPostgrestInsert.mockResolvedValueOnce(undefined);
    await generateApiKey('bob');

    expect(mockPostgrestInsert).toHaveBeenCalledWith('api_keys', expect.objectContaining({
      tier: 'public',
      rate_limit: 30,
    }));
  });

  it('generates unique keys on successive calls', async () => {
    mockPostgrestInsert.mockResolvedValue(undefined);
    const key1 = await generateApiKey('owner1');
    const key2 = await generateApiKey('owner2');
    expect(key1).not.toBe(key2);
  });

  it('propagates insert errors', async () => {
    mockPostgrestInsert.mockRejectedValueOnce(new Error('DB down'));
    await expect(generateApiKey('fail')).rejects.toThrow('DB down');
  });
});

describe('validateApiKey', () => {
  it('returns key info for valid active key', async () => {
    mockPostgrestSelect.mockResolvedValueOnce([{
      owner: 'alice',
      tier: 'premium',
      rate_limit: 120,
    }]);

    const result = await validateApiKey('nsa_abc123');
    expect(result).toEqual({
      owner: 'alice',
      tier: 'premium',
      rate_limit: 120,
    });
  });

  it('queries with SHA-256 hash of the key', async () => {
    mockPostgrestSelect.mockResolvedValueOnce([]);
    await validateApiKey('nsa_testkey');

    expect(mockPostgrestSelect).toHaveBeenCalledWith(expect.objectContaining({
      table: 'api_keys',
      query: expect.objectContaining({
        key_hash: expect.stringMatching(/^eq\.[a-f0-9]{64}$/),
        active: 'eq.true',
      }),
    }));
  });

  it('returns null when key not found', async () => {
    mockPostgrestSelect.mockResolvedValueOnce([]);
    const result = await validateApiKey('nsa_nonexistent');
    expect(result).toBeNull();
  });

  it('returns null on database error', async () => {
    mockPostgrestSelect.mockRejectedValueOnce(new Error('connection refused'));
    const result = await validateApiKey('nsa_broken');
    expect(result).toBeNull();
  });

  it('generated key validates with matching hash', async () => {
    // Generate a key and capture the hash that was inserted
    mockPostgrestInsert.mockResolvedValueOnce(undefined);
    const rawKey = await generateApiKey('test');
    const insertedHash = mockPostgrestInsert.mock.calls[0]![1].key_hash;

    // Now validate — mock the select to return when hash matches
    mockPostgrestSelect.mockImplementationOnce(async (opts: { query: { key_hash: string } }) => {
      const queriedHash = opts.query.key_hash.replace('eq.', '');
      if (queriedHash === insertedHash) {
        return [{ owner: 'test', tier: 'public', rate_limit: 30 }];
      }
      return [];
    });

    const result = await validateApiKey(rawKey);
    expect(result).toEqual({ owner: 'test', tier: 'public', rate_limit: 30 });
  });
});
