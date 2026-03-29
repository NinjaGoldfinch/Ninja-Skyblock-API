import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelElectionResponse } from '../types/hypixel.js';

const log = createLogger('resource-election');
const QUEUE_NAME = 'resource-election';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;
let lastTtlRefresh = 0;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelElectionResponse>(
    { endpoint: '/v2/resources/skyblock/election', noApiKey: true },
    lastModifiedHeader,
  );

  if (!result.modified) {
    if (Date.now() - lastTtlRefresh > 60_000) {
      lastTtlRefresh = Date.now();
      await cacheRefreshTtl('warm', 'resources', 'election');
    }
    return;
  }
  lastTtlRefresh = Date.now();

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  await cacheSet('warm', 'resources', 'election', response, response.lastUpdated);

  const hash = contentHash(response.mayor);
  if (hash !== lastContentHash) {
    lastContentHash = hash;
    try {
      await postgrestInsert('resource_snapshots', {
        resource_type: 'election',
        version: String(response.lastUpdated),
        raw_data: response as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.error({ err }, 'Failed to insert election snapshot');
    }
    log.info({ mayor: response.mayor.name }, 'Election updated (new content)');
  } else {
    log.debug({ mayor: response.mayor.name }, 'Election fetched but content unchanged');
  }
}

export function startElectionTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'election-poll',
    { every: 1000 },
    { name: 'election-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('election-immediate', {}, { priority: 1 });
}
