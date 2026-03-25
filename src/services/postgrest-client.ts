import { env } from '../config/env.js';
import { errors } from '../utils/errors.js';

interface PostgrestQueryOptions {
  table: string;
  query?: Record<string, string>;
  select?: string;
  order?: string;
  limit?: number;
}

async function postgrestFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${env.POSTGREST_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw errors.internal(new Error(`PostgREST error ${response.status}: ${body}`));
  }

  return response.json() as Promise<T>;
}

export async function postgrestSelect<T>(options: PostgrestQueryOptions): Promise<T[]> {
  const params = new URLSearchParams();
  if (options.select) params.set('select', options.select);
  if (options.order) params.set('order', options.order);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      params.set(key, value);
    }
  }

  const queryString = params.toString();
  const path = `/${options.table}${queryString ? `?${queryString}` : ''}`;
  return postgrestFetch<T[]>(path);
}

export async function postgrestInsert<T>(table: string, rows: T | T[]): Promise<void> {
  await postgrestFetch(`/${table}`, {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: {
      'Prefer': 'resolution=ignore-duplicates',
    },
  });
}

export async function postgrestRpc<T>(functionName: string, params: Record<string, unknown>): Promise<T> {
  return postgrestFetch<T>(`/rpc/${functionName}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
