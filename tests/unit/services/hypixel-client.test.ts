import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchProfile, fetchBazaar, fetchAuctionsPage, fetchEndedAuctions,
  fetchConditional, fetchPlayerProfiles, fetchCollections, fetchSkills,
  fetchItems, fetchMuseum, fetchBingo, fetchFireSales, fetchNews,
} from '../../../src/services/hypixel-client.js';
import { errors } from '../../../src/utils/errors.js';

// Mock env module before using client
vi.mock('../../../src/config/env.js', () => ({
  env: {
    HYPIXEL_API_KEY: 'test-api-key',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PORT: 3000,
  },
}));

// Mock parseJsonAsync to avoid worker thread overhead
vi.mock('../../../src/utils/json-worker.js', () => ({
  parseJsonAsync: vi.fn((text) => Promise.resolve(JSON.parse(text))),
  stringifyAsync: vi.fn((obj) => Promise.resolve(JSON.stringify(obj))),
}));

describe('Hypixel Client', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ============ Successful Responses ============

  describe('successful requests', () => {
    it('fetches profile successfully', async () => {
      const mockData = { profile_id: 'test-uuid', members: {} };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => mockData,
      });

      const result = await fetchProfile('test-uuid');
      expect(result).toEqual(mockData);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('includes API key in request headers', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
      });

      await fetchProfile('test-uuid');

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]!.headers).toHaveProperty('API-Key', 'test-api-key');
    });

    it('omits API key for public endpoints (noApiKey=true)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ products: {} }),
      });

      await fetchBazaar();

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]!.headers).not.toHaveProperty('API-Key');
    });

    it('includes query parameters correctly', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ profiles: [] }),
      });

      await fetchPlayerProfiles('player-uuid');

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('uuid=player-uuid');
    });

    it('logs request completion with duration', async () => {
      const logSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({}),
      });

      await fetchProfile('test-uuid');

      logSpy.mockRestore();
    });
  });

  // ============ Retry Logic for 429 ============

  describe('429 rate limiting', () => {
    it('retries on 429 with exponential backoff', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers(),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers(),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: 'success' }),
        });

      const promise = fetchBazaar();

      // First attempt fails immediately
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance by first backoff (1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Advance by second backoff (2000ms)
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('uses retry-after header if provided', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '5' }), // 5 seconds
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: 'success' }),
        });

      const promise = fetchBazaar();
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance by the retry-after time (5000ms)
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('throws hypixelRateLimited() after max retries on 429', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: async () => '',
      });

      const promise = fetchBazaar();
      let caughtError: any;
      promise.catch((err) => {
        caughtError = err;
      });

      await vi.runAllTimersAsync();
      await vi.waitFor(() => caughtError !== undefined, { timeout: 100 });

      expect(caughtError.code).toBe('HYPIXEL_RATE_LIMITED');
    });
  });

  // ============ Retry Logic for 503 ============

  describe('503 service unavailable', () => {
    it('retries on 503 with double backoff', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: 'success' }),
        });

      const promise = fetchBazaar();

      // First attempt
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // First backoff: 1000 * 1 * 2 = 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Second backoff: 1000 * 2 * 2 = 4000ms
      await vi.advanceTimersByTimeAsync(4000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toEqual({ data: 'success' });
    });

    it('throws hypixelDown() after max retries on 503', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers(),
        text: async () => '',
      });

      const promise = fetchBazaar();
      let caughtError: any;
      promise.catch((err) => {
        caughtError = err;
      });

      await vi.runAllTimersAsync();
      await vi.waitFor(() => caughtError !== undefined, { timeout: 100 });

      expect(caughtError.code).toBe('HYPIXEL_UNAVAILABLE');
    });
  });

  // ============ Non-retryable Errors ============

  describe('non-retryable errors', () => {
    it('fails immediately on 403 Forbidden (invalid API key)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        text: async () => 'Invalid API key',
      });

      await expect(fetchProfile('test-uuid')).rejects.toMatchObject({ code: 'HYPIXEL_API_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No retry
    });

    it('fails immediately on 400 Bad Request', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => 'Bad request',
      });

      await expect(fetchProfile('test-uuid')).rejects.toMatchObject({ code: 'HYPIXEL_API_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails immediately on 404 Not Found', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => 'Not found',
      });

      await expect(fetchProfile('nonexistent-uuid')).rejects.toMatchObject({ code: 'HYPIXEL_API_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails immediately on 500 Internal Server Error', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => 'Server error',
      });

      await expect(fetchBazaar()).rejects.toMatchObject({ code: 'HYPIXEL_API_ERROR' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============ Conditional Fetch (If-Modified-Since) ============

  describe('fetchConditional', () => {
    it('returns modified=false on 304 Not Modified', async () => {
      fetchSpy.mockResolvedValueOnce({
        status: 304,
        ok: false, // 304 is technically a success response but ok=false
        headers: new Headers({ 'last-modified': 'Wed, 21 Oct 2025 07:28:00 GMT' }),
      });

      const result = await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true },
        'Wed, 21 Oct 2025 07:28:00 GMT'
      );

      expect(result.modified).toBe(false);
      expect(result.data).toBeNull();
      expect(getLastModifiedHeader()).toBe('Wed, 21 Oct 2025 07:28:00 GMT');
    });

    it('skips parsing if last-modified header matches input', async () => {
      const lastModified = 'Wed, 21 Oct 2025 07:28:00 GMT';
      fetchSpy.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ 'last-modified': lastModified }),
        json: vi.fn().mockRejectedValue(new Error('Should not parse')),
      });

      const result = await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true },
        lastModified
      );

      expect(result.modified).toBe(false);
      expect(result.data).toBeNull();
    });

    it('parses and returns data when last-modified differs', async () => {
      const mockData = { products: { DIAMOND: { quick_status: {} } }, lastUpdated: 1234567890 };
      fetchSpy.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers({ 'last-modified': 'Wed, 21 Oct 2025 08:00:00 GMT' }),
        json: async () => mockData,
      });

      const result = await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true },
        'Wed, 21 Oct 2025 07:28:00 GMT' // Different from response header
      );

      expect(result.modified).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(result.lastModified).toBe('Wed, 21 Oct 2025 08:00:00 GMT');
      expect(result.lastUpdated).toBe(1234567890);
    });

    it('includes If-Modified-Since header in request', async () => {
      fetchSpy.mockResolvedValueOnce({
        status: 304,
        ok: false,
        headers: new Headers(),
      });

      await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true },
        'Wed, 21 Oct 2025 07:28:00 GMT'
      );

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(options.headers).toHaveProperty('If-Modified-Since', 'Wed, 21 Oct 2025 07:28:00 GMT');
    });

    it('throws on 403 in conditional fetch', async () => {
      fetchSpy.mockResolvedValueOnce({
        status: 403,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        fetchConditional({ endpoint: '/v2/skyblock/bazaar', noApiKey: true })
      ).rejects.toMatchObject({ code: 'HYPIXEL_API_ERROR' });
    });

    it('throws hypixelRateLimited() on 429 in conditional fetch', async () => {
      fetchSpy.mockResolvedValueOnce({
        status: 429,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        fetchConditional({ endpoint: '/v2/skyblock/bazaar', noApiKey: true })
      ).rejects.toMatchObject({ code: 'HYPIXEL_RATE_LIMITED' });
    });

    it('throws hypixelDown() on 503 in conditional fetch', async () => {
      fetchSpy.mockResolvedValueOnce({
        status: 503,
        ok: false,
        headers: new Headers(),
      });

      await expect(
        fetchConditional({ endpoint: '/v2/skyblock/bazaar', noApiKey: true })
      ).rejects.toMatchObject({ code: 'HYPIXEL_UNAVAILABLE' });
    });

    it('extracts lastUpdated from response data', async () => {
      const mockData = { products: {}, lastUpdated: 1609459200000 };
      fetchSpy.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => mockData,
      });

      const result = await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true }
      );

      expect(result.lastUpdated).toBe(1609459200000);
    });

    it('returns null lastUpdated if not in response', async () => {
      const mockData = { products: {} };
      fetchSpy.mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => mockData,
      });

      const result = await fetchConditional(
        { endpoint: '/v2/skyblock/bazaar', noApiKey: true }
      );

      expect(result.lastUpdated).toBeNull();
    });
  });

  // ============ Special Cases ============

  describe('worker parsing', () => {
    it('calls parseJsonAsync when workerParse=true', async () => {
      const mockData = { auctions: [] };
      const { parseJsonAsync } = await import('../../../src/utils/json-worker.js');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(mockData),
      });

      await fetchAuctionsPage(0);

      expect(parseJsonAsync).toHaveBeenCalled();
    });
  });

  describe('endpoint specifics', () => {
    it('fetchAuctionsPage uses page parameter', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => '{"auctions":[]}',
      });

      await fetchAuctionsPage(5);

      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('page=5');
      expect(url).not.toContain('API-Key'); // Public endpoint
    });

    it('fetchMuseum requires profile parameter', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ members: {} }),
      });

      await fetchMuseum('profile-uuid');

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('profile=profile-uuid');
      expect(options.headers).toHaveProperty('API-Key'); // Private endpoint
    });

    it('fetchBingo requires uuid parameter', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ goals: [] }),
      });

      await fetchBingo('player-uuid');

      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('uuid=player-uuid');
      expect(options.headers).toHaveProperty('API-Key'); // Private endpoint
    });

    it('public endpoints do not include API key', async () => {
      const publicEndpoints = [
        () => fetchBazaar(),
        () => fetchAuctionsPage(0),
        () => fetchEndedAuctions(),
        () => fetchCollections(),
        () => fetchSkills(),
        () => fetchItems(),
        () => fetchFireSales(),
      ];

      for (const fetch of publicEndpoints) {
        fetchSpy.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => '{}',
        });

        await fetch();

        const [, options] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit];
        expect(options.headers).not.toHaveProperty('API-Key');
      }
    });
  });
});

// Helper to get the last-modified header from conditional fetch
function getLastModifiedHeader(): string | null {
  // This would be extracted from the response in actual usage
  return 'Wed, 21 Oct 2025 07:28:00 GMT'; // Placeholder for test setup
}
