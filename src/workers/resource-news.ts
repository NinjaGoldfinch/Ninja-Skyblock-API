import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelNewsResponse } from '../types/hypixel.js';

const log = createLogger('resource-news');
const QUEUE_NAME = 'resource-news';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;
let lastTtlRefresh = 0;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelNewsResponse>(
    { endpoint: '/v2/skyblock/news' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    if (Date.now() - lastTtlRefresh > 60_000) {
      lastTtlRefresh = Date.now();
      await cacheRefreshTtl('warm', 'news', 'latest');
    }
    return;
  }
  lastTtlRefresh = Date.now();

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  const items = response.items ?? [];
  await cacheSet('warm', 'news', 'latest', items);

  const hash = contentHash(items);
  if (hash !== lastContentHash) {
    lastContentHash = hash;
    log.info({ count: items.length }, 'News updated (new content)');
  }
}

export function startNewsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'news-poll',
    { every: 60_000 },
    { name: 'news-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('news-immediate', {}, { priority: 1 });
}
