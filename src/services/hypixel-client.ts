import { Agent, setGlobalDispatcher } from 'undici';
import { env } from '../config/env.js';
import { HYPIXEL_BASE_URL } from '../config/constants.js';
import { errors } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import type {
  HypixelProfilesResponse, HypixelProfileResponse, HypixelBazaarResponse,
  HypixelAuctionsPageResponse, HypixelPlayerAuctionsResponse, HypixelEndedAuctionsResponse,
} from '../types/hypixel.js';

const log = createLogger('hypixel-client');

// Allow up to 100 concurrent connections per origin (default is ~10)
setGlobalDispatcher(new Agent({
  connections: 100,
  pipelining: 1,
}));

interface HypixelRequestOptions {
  endpoint: string;
  params?: Record<string, string>;
  logLevel?: 'debug' | 'trace';
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHypixel<T>(options: HypixelRequestOptions): Promise<T> {
  const url = new URL(options.endpoint, HYPIXEL_BASE_URL);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  let lastError: unknown;
  const startTime = Date.now();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), {
      headers: {
        'API-Key': env.HYPIXEL_API_KEY,
        'Accept': 'application/json',
      },
    });

    // 403 — invalid key, stop immediately
    if (response.status === 403) {
      log.error({ endpoint: options.endpoint, status: 403 }, 'Hypixel API forbidden — invalid key');
      throw errors.hypixelError(new Error('Hypixel API returned 403 Forbidden'));
    }

    // 429 — rate limited, back off and retry
    if (response.status === 429) {
      lastError = new Error('Hypixel API rate limited (429)');
      const retryAfter = response.headers.get('retry-after');
      const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY_MS * (attempt + 1);
      log.warn({ endpoint: options.endpoint, attempt, delay_ms: delayMs }, 'Hypixel rate limited, backing off');
      await sleep(delayMs);
      continue;
    }

    // 503 — Hypixel down, retry with different timing
    if (response.status === 503) {
      lastError = new Error('Hypixel API unavailable (503)');
      const delayMs = RETRY_DELAY_MS * (attempt + 1) * 2;
      log.warn({ endpoint: options.endpoint, attempt, delay_ms: delayMs }, 'Hypixel unavailable, retrying');
      await sleep(delayMs);
      continue;
    }

    // Other non-OK responses
    if (!response.ok) {
      const body = await response.text();
      log.error({ endpoint: options.endpoint, status: response.status }, 'Hypixel API error');
      throw errors.hypixelError(new Error(`Hypixel API returned ${response.status}: ${body}`));
    }

    const data = await response.json() as T;
    const level = options.logLevel ?? 'debug';
    log[level]({ endpoint: options.endpoint, params: options.params, duration_ms: Date.now() - startTime }, 'Hypixel API request completed');
    return data;
  }

  // Exhausted retries
  if (lastError instanceof Error && lastError.message.includes('503')) {
    throw errors.hypixelDown();
  }
  throw errors.hypixelRateLimited();
}

export async function fetchProfile(profileUuid: string): Promise<HypixelProfileResponse> {
  return fetchHypixel<HypixelProfileResponse>({
    endpoint: '/v2/skyblock/profile',
    params: { profile: profileUuid },
  });
}

export async function fetchPlayerProfiles(playerUuid: string): Promise<HypixelProfilesResponse> {
  return fetchHypixel<HypixelProfilesResponse>({
    endpoint: '/v2/skyblock/profiles',
    params: { uuid: playerUuid },
  });
}

export async function fetchBazaar(): Promise<HypixelBazaarResponse> {
  return fetchHypixel<HypixelBazaarResponse>({
    endpoint: '/v2/skyblock/bazaar',
  });
}

export async function fetchAuctionsPage(page: number): Promise<HypixelAuctionsPageResponse> {
  return fetchHypixel<HypixelAuctionsPageResponse>({
    endpoint: '/v2/skyblock/auctions',
    params: { page: String(page) },
    logLevel: 'trace',
  });
}

export async function fetchPlayerAuctions(playerUuid: string): Promise<HypixelPlayerAuctionsResponse> {
  return fetchHypixel<HypixelPlayerAuctionsResponse>({
    endpoint: '/v2/skyblock/auction',
    params: { player: playerUuid },
  });
}

export async function fetchEndedAuctions(): Promise<HypixelEndedAuctionsResponse> {
  return fetchHypixel<HypixelEndedAuctionsResponse>({
    endpoint: '/v2/skyblock/auctions_ended',
  });
}

export interface ConditionalFetchResult<T> {
  modified: boolean;
  data: T | null;
  lastModified: string | null;
  lastUpdated: number | null;
}

/**
 * Fetch with If-Modified-Since header. Returns modified=false if
 * the server returns 304 or the last-modified header hasn't changed.
 * Avoids parsing the full JSON body when data hasn't been updated.
 */
export async function fetchConditional<T>(
  options: HypixelRequestOptions,
  ifModifiedSince?: string,
): Promise<ConditionalFetchResult<T>> {
  const url = new URL(options.endpoint, HYPIXEL_BASE_URL);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    'API-Key': env.HYPIXEL_API_KEY,
    'Accept': 'application/json',
  };
  if (ifModifiedSince) {
    headers['If-Modified-Since'] = ifModifiedSince;
  }

  const startTime = Date.now();
  const response = await fetch(url.toString(), { headers });

  // 304 Not Modified — data hasn't changed
  if (response.status === 304) {
    log.trace({ endpoint: options.endpoint }, 'Not modified (304)');
    return { modified: false, data: null, lastModified: ifModifiedSince ?? null, lastUpdated: null };
  }

  if (!response.ok) {
    // Fall through to normal error handling for non-2xx
    if (response.status === 403) throw errors.hypixelError(new Error('403 Forbidden'));
    if (response.status === 429) throw errors.hypixelRateLimited();
    if (response.status === 503) throw errors.hypixelDown();
    throw errors.hypixelError(new Error(`Hypixel API returned ${response.status}`));
  }

  const lastModified = response.headers.get('last-modified');

  // If last-modified matches what we already have, skip parsing
  if (ifModifiedSince && lastModified === ifModifiedSince) {
    log.trace({ endpoint: options.endpoint }, 'Same last-modified, skipping parse');
    return { modified: false, data: null, lastModified, lastUpdated: null };
  }

  const data = await response.json() as T;
  const lastUpdated = (data as Record<string, unknown>)['lastUpdated'] as number | undefined;
  log.debug({ endpoint: options.endpoint, duration_ms: Date.now() - startTime }, 'Conditional fetch — new data');

  return {
    modified: true,
    data,
    lastModified,
    lastUpdated: lastUpdated ?? null,
  };
}

export { fetchHypixel };
