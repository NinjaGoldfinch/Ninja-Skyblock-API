import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelFireSalesResponse } from '../types/hypixel.js';

const log = createLogger('resource-firesales');
const QUEUE_NAME = 'resource-firesales';

let lastModifiedHeader: string | undefined;
let lastTtlRefresh = 0;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelFireSalesResponse>(
    { endpoint: '/v2/skyblock/firesales', noApiKey: true },
    lastModifiedHeader,
  );

  if (!result.modified) {
    if (Date.now() - lastTtlRefresh > 60_000) {
      lastTtlRefresh = Date.now();
      await cacheRefreshTtl('warm', 'firesales', 'latest');
    }
    return;
  }
  lastTtlRefresh = Date.now();

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  const sales = response.sales ?? [];
  await cacheSet('warm', 'firesales', 'latest', sales);
  log.info({ count: sales.length }, 'Fire sales updated');
}

export function startFireSalesTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'firesales-poll',
    { every: 1000 },
    { name: 'firesales-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('firesales-immediate', {}, { priority: 1 });
}
