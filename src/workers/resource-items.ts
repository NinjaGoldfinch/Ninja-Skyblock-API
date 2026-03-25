import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelItemsResponse } from '../types/hypixel.js';

const log = createLogger('resource-items');
const QUEUE_NAME = 'resource-items';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;

export interface ProcessedItem {
  id: string;
  name: string;
  material: string;
  tier?: string;
  category?: string;
  npc_sell_price?: number;
  museum?: boolean;
}

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

  const hash = contentHash(response.items);
  if (hash === lastContentHash) {
    log.debug({ item_count: response.items.length }, 'Items fetched but content unchanged');
    return;
  }
  lastContentHash = hash;

  // Build lookup maps
  const idToName: Record<string, string> = {};     // HYPERION -> "Hyperion"
  const nameToId: Record<string, string> = {};     // "Hyperion" -> HYPERION
  const knownNames = new Set<string>();             // Set of all display names

  const processedItems: ProcessedItem[] = [];

  for (const item of response.items) {
    idToName[item.id] = item.name;
    nameToId[item.name] = item.id;
    knownNames.add(item.name);

    processedItems.push({
      id: item.id,
      name: item.name,
      material: item.material,
      tier: item.tier,
      category: item.category,
      npc_sell_price: item.npc_sell_price,
      museum: item.museum,
    });
  }

  // Cache everything
  const ts = response.lastUpdated;
  await cacheSet('warm', 'resources', 'items', processedItems, ts);
  await cacheSet('warm', 'resources', 'items-raw', response.items, ts);
  await cacheSet('warm', 'resources', 'item-id-to-name', idToName, ts);
  await cacheSet('warm', 'resources', 'item-name-to-id', nameToId, ts);
  await cacheSet('warm', 'resources', 'item-known-names', Array.from(knownNames), ts);

  // Store to Postgres
  try {
    await postgrestInsert('resource_snapshots', {
      resource_type: 'items',
      version: String(response.lastUpdated),
      raw_data: response as unknown as Record<string, unknown>,
    });
  } catch (err) {
    log.error({ err }, 'Failed to insert items snapshot');
  }

  log.info({ item_count: response.items.length }, 'Items updated (new content)');
}

export function startItemsTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'items-poll',
    { every: 1000 },
    { name: 'items-poll' },
  );

  createWorker(QUEUE_NAME, processJob);
  queue.add('items-immediate', {}, { priority: 1 });
}
