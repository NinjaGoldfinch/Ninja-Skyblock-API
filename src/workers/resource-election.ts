import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelElectionResponse } from '../types/hypixel.js';

const log = createLogger('resource-election');
const QUEUE_NAME = 'resource-election';

let lastModifiedHeader: string | undefined;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelElectionResponse>(
    { endpoint: '/v2/resources/skyblock/election' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Election data unchanged');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  await cacheSet('warm', 'resources', 'election', response, response.lastUpdated);

  try {
    await postgrestInsert('resource_snapshots', {
      resource_type: 'election',
      version: String(response.lastUpdated),
      raw_data: response as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.error({ err }, 'Failed to insert election snapshot');
  }

  log.info({ mayor: response.mayor.name }, 'Election updated');
}

export function startElectionTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 1s — conditional fetch skips when unchanged
  queue.upsertJobScheduler(
    'election-poll',
    { every: 1000 },
    { name: 'election-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('election-immediate', {}, { priority: 1 });
}
