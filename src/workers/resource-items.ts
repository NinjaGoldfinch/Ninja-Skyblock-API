import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelItemsResponse } from '../types/hypixel.js';

const log = createLogger('resource-items');
const QUEUE_NAME = 'resource-items';

let lastModifiedHeader: string | undefined;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelItemsResponse>(
    { endpoint: '/v2/resources/skyblock/items' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Items data unchanged');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  // Cache full items list and build an id->name lookup map
  await cacheSet('warm', 'resources', 'items', response.items, response.lastUpdated);

  const itemLookup: Record<string, string> = {};
  for (const item of response.items) {
    itemLookup[item.id] = item.name;
  }
  await cacheSet('warm', 'resources', 'item-lookup', itemLookup, response.lastUpdated);

  log.info({ item_count: response.items.length }, 'Items updated');
}

export function startItemsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'items-poll',
    { every: 60_000 },
    { name: 'items-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('items-immediate', {}, { priority: 1 });
}
