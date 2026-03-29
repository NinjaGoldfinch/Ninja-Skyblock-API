import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelSkillsResponse } from '../types/hypixel.js';

const log = createLogger('resource-skills');
const QUEUE_NAME = 'resource-skills';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;
let lastTtlRefresh = 0;

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelSkillsResponse>(
    { endpoint: '/v2/resources/skyblock/skills', noApiKey: true },
    lastModifiedHeader,
  );

  if (!result.modified) {
    if (Date.now() - lastTtlRefresh > 60_000) {
      lastTtlRefresh = Date.now();
      await cacheRefreshTtl('warm', 'resources', 'skills');
    }
    return;
  }
  lastTtlRefresh = Date.now();

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) return;

  await cacheSet('warm', 'resources', 'skills', response, response.lastUpdated);

  const hash = contentHash(response.skills);
  if (hash !== lastContentHash) {
    lastContentHash = hash;
    try {
      await postgrestInsert('resource_snapshots', {
        resource_type: 'skills',
        version: response.version,
        raw_data: response as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.error({ err }, 'Failed to insert skills snapshot');
    }
    log.info({ version: response.version }, 'Skills updated (new content)');
  } else {
    log.debug({ version: response.version }, 'Skills fetched but content unchanged');
  }
}

export function startSkillsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'skills-poll',
    { every: 1000 },
    { name: 'skills-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('skills-immediate', {}, { priority: 1 });
}
