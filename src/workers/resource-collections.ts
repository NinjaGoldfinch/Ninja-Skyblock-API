import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelCollectionsResponse } from '../types/hypixel.js';

const log = createLogger('resource-collections');
const QUEUE_NAME = 'resource-collections';

let lastModifiedHeader: string | undefined;

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
  log.info({ version: response.version }, 'Collections updated');
}

export function startCollectionsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 60s — conditional fetch skips when unchanged
  queue.upsertJobScheduler(
    'collections-poll',
    { every: 60_000 },
    { name: 'collections-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('collections-immediate', {}, { priority: 1 });
}
