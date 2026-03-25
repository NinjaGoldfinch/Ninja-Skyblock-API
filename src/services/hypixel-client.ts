import { env } from '../config/env.js';
import { HYPIXEL_BASE_URL } from '../config/constants.js';
import { errors } from '../utils/errors.js';
import type { HypixelProfilesResponse, HypixelProfileResponse, HypixelBazaarResponse } from '../types/hypixel.js';

interface HypixelRequestOptions {
  endpoint: string;
  params?: Record<string, string>;
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

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), {
      headers: {
        'API-Key': env.HYPIXEL_API_KEY,
        'Accept': 'application/json',
      },
    });

    // 403 — invalid key, stop immediately
    if (response.status === 403) {
      throw errors.hypixelError(new Error('Hypixel API returned 403 Forbidden'));
    }

    // 429 — rate limited, back off and retry
    if (response.status === 429) {
      lastError = new Error('Hypixel API rate limited (429)');
      const retryAfter = response.headers.get('retry-after');
      const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY_MS * (attempt + 1);
      await sleep(delayMs);
      continue;
    }

    // 503 — Hypixel down, retry with different timing
    if (response.status === 503) {
      lastError = new Error('Hypixel API unavailable (503)');
      await sleep(RETRY_DELAY_MS * (attempt + 1) * 2);
      continue;
    }

    // Other non-OK responses
    if (!response.ok) {
      const body = await response.text();
      throw errors.hypixelError(new Error(`Hypixel API returned ${response.status}: ${body}`));
    }

    const data = await response.json() as T;
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

export { fetchHypixel };
