import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelCollectionsResponse } from '../types/hypixel.js';

const log = createLogger('resource-collections');
const QUEUE_NAME = 'resource-collections';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelCollectionsResponse>(
    { endpoint: '/v2/resources/skyblock/collections' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Collections data unchanged');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  await cacheSet('warm', 'resources', 'collections', response, response.lastUpdated);

  const hash = contentHash(response.collections);
  if (hash !== lastContentHash) {
    lastContentHash = hash;
    try {
      await postgrestInsert('resource_snapshots', {
        resource_type: 'collections',
        version: response.version,
        raw_data: response as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.error({ err }, 'Failed to insert collections snapshot');
    }
    log.info({ version: response.version }, 'Collections updated (new content)');
  } else {
    log.debug({ version: response.version }, 'Collections fetched but content unchanged');
  }
}

export function startCollectionsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'collections-poll',
    { every: 1000 },
    { name: 'collections-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('collections-immediate', {}, { priority: 1 });
}
