import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelSkillsResponse } from '../types/hypixel.js';

const log = createLogger('resource-skills');
const QUEUE_NAME = 'resource-skills';

let lastModifiedHeader: string | undefined;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelSkillsResponse>(
    { endpoint: '/v2/resources/skyblock/skills' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Skills data unchanged');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  await cacheSet('warm', 'resources', 'skills', response, response.lastUpdated);

  try {
    await postgrestInsert('resource_snapshots', {
      resource_type: 'skills',
      version: response.version,
      raw_data: response as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.error({ err }, 'Failed to insert skills snapshot');
  }

  log.info({ version: response.version }, 'Skills updated');
}

export function startSkillsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 1s — conditional fetch skips when unchanged
  queue.upsertJobScheduler(
    'skills-poll',
    { every: 1000 },
    { name: 'skills-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('skills-immediate', {}, { priority: 1 });
}
