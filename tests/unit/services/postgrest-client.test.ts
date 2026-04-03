import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/env.js', () => ({
  env: {
    POSTGREST_URL: 'http://localhost:3001',
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
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

import { postgrestSelect, postgrestInsert, postgrestRpc } from '../../../src/services/postgrest-client.js';

let fetchSpy: ReturnType<typeof vi.fn>;

function mockFetchOk(data: unknown) {
  const text = data !== undefined ? JSON.stringify(data) : '';
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => text,
  });
}

function mockFetchError(status: number, body: string) {
  fetchSpy.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => body,
  });
}

beforeEach(() => {
  fetchSpy = vi.fn();
  global.fetch = fetchSpy;
  vi.clearAllMocks();
});

describe('postgrestSelect', () => {
  it('builds correct URL with table name', async () => {
    mockFetchOk([{ id: 1 }]);
    await postgrestSelect({ table: 'users' });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/users');
  });

  it('adds select, order, limit, offset params', async () => {
    mockFetchOk([]);
    await postgrestSelect({
      table: 'bazaar_snapshots',
      select: 'item_id,price',
      order: 'price.desc',
      limit: 10,
      offset: 20,
    });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('select=item_id%2Cprice');
    expect(url).toContain('order=price.desc');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('adds custom query filters', async () => {
    mockFetchOk([]);
    await postgrestSelect({
      table: 'api_keys',
      query: { key_hash: 'eq.abc123', active: 'eq.true' },
    });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('key_hash=eq.abc123');
    expect(url).toContain('active=eq.true');
  });

  it('omits undefined optional params', async () => {
    mockFetchOk([]);
    await postgrestSelect({ table: 'items' });

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/items');
    expect(url).not.toContain('?');
  });

  it('returns parsed JSON array', async () => {
    const data = [{ id: 1, name: 'test' }, { id: 2, name: 'test2' }];
    mockFetchOk(data);

    const result = await postgrestSelect({ table: 'items' });
    expect(result).toEqual(data);
  });

  it('includes JSON headers', async () => {
    mockFetchOk([]);
    await postgrestSelect({ table: 'items' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });
});

describe('postgrestInsert', () => {
  it('POSTs single row with JSON body', async () => {
    mockFetchOk(undefined);
    await postgrestInsert('users', { name: 'alice', tier: 'public' });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/users');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'alice', tier: 'public' });
  });

  it('POSTs array of rows', async () => {
    mockFetchOk(undefined);
    const rows = [{ id: 1 }, { id: 2 }];
    await postgrestInsert('items', rows);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(rows);
  });

  it('appends on_conflict to URL when specified', async () => {
    mockFetchOk(undefined);
    await postgrestInsert('items', { id: 1 }, 'id');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/items?on_conflict=id');
  });

  it('includes Prefer header for conflict resolution', async () => {
    mockFetchOk(undefined);
    await postgrestInsert('items', { id: 1 });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Prefer']).toBe('resolution=ignore-duplicates');
  });
});

describe('postgrestRpc', () => {
  it('POSTs to /rpc/functionName with JSON params', async () => {
    mockFetchOk({ result: 42 });
    await postgrestRpc('aggregate_bazaar', { hours: 24 });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/rpc/aggregate_bazaar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ hours: 24 });
  });

  it('returns parsed response', async () => {
    mockFetchOk({ total: 100 });
    const result = await postgrestRpc('count_items', {});
    expect(result).toEqual({ total: 100 });
  });
});

describe('error handling', () => {
  it('throws on non-ok response', async () => {
    mockFetchError(500, 'Internal Server Error');
    await expect(postgrestSelect({ table: 'items' })).rejects.toThrow();
  });

  it('error cause includes status code', async () => {
    mockFetchError(404, 'Not Found');
    try {
      await postgrestSelect({ table: 'missing' });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const appErr = err as { cause?: { message?: string }; message: string };
      // The AppError wraps the PostgREST error as its cause
      expect(appErr.cause?.message).toMatch(/PostgREST error 404/);
    }
  });

  it('returns undefined for empty response body', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });

    const result = await postgrestSelect({ table: 'empty' });
    expect(result).toBeUndefined();
  });
});
