import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelItemsResponse } from '../types/hypixel.js';
import { formatProductId } from './bazaar-tracker.js';

const log = createLogger('resource-items');
const QUEUE_NAME = 'resource-items';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;
let lastTtlRefresh = 0;

export interface ProcessedItem {
  id: string;
  name: string;
  material: string;
  tier?: string;
  category?: string;
  npc_sell_price?: number;
  museum?: boolean;
  is_bazaar_sellable?: boolean;
  is_auctionable?: boolean;
}

/** Strip Minecraft formatting codes from item names (§3, §l, %%red%%, etc). */
function stripColorCodes(name: string): string {
  return name
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/%%[a-z_]+%%/gi, '')
    .trim();
}

async function processJob(_job: Job): Promise<void> {
  const result = await fetchConditional<HypixelItemsResponse>(
    { endpoint: '/v2/resources/skyblock/items', noApiKey: true },
    lastModifiedHeader,
  );

  if (!result.modified) {
    // Refresh TTLs every 60s so keys don't expire while data hasn't changed
    if (Date.now() - lastTtlRefresh > 60_000) {
      lastTtlRefresh = Date.now();
      await cacheRefreshTtl('warm', 'resources', 'items');
      await cacheRefreshTtl('warm', 'resources', 'items-raw');
      await cacheRefreshTtl('warm', 'resources', 'item-id-to-name');
      await cacheRefreshTtl('warm', 'resources', 'item-name-to-id');
      await cacheRefreshTtl('warm', 'resources', 'item-known-names');
      await cacheRefreshTtl('warm', 'resources', 'bazaar-product-ids');
      await cacheRefreshTtl('warm', 'resources', 'seen-auction-items');
    }
    return;
  }
  lastTtlRefresh = Date.now();

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
    const name = stripColorCodes(item.name);
    idToName[item.id] = name;
    nameToId[name] = item.id;
    knownNames.add(name);

    processedItems.push({
      id: item.id,
      name,
      material: item.material,
      tier: item.tier,
      category: item.category,
      npc_sell_price: item.npc_sell_price,
      museum: item.museum,
    });
  }

  // Enrich items with trading flags from bazaar and auction caches
  const [bazaarCache, auctionCache] = await Promise.all([
    cacheGet<string[]>('warm', 'resources', 'bazaar-product-ids'),
    cacheGet<string[]>('warm', 'resources', 'seen-auction-items'),
  ]);
  const bazaarSet = new Set(bazaarCache?.data ?? []);
  const auctionSet = new Set(auctionCache?.data ?? []);

  const existingIds = new Set(processedItems.map((i) => i.id));

  for (const item of processedItems) {
    if (bazaarSet.has(item.id)) item.is_bazaar_sellable = true;
    if (auctionSet.has(item.id)) item.is_auctionable = true;
  }

  // Add bazaar-only items not in the Hypixel items resource (e.g. enchantments, essences)
  let bazaarOnly = 0;
  for (const productId of bazaarSet) {
    if (existingIds.has(productId)) continue;
    const name = formatProductId(productId);
    idToName[productId] = name;
    nameToId[name] = productId;
    knownNames.add(name);
    processedItems.push({
      id: productId,
      name,
      material: 'PAPER',
      is_bazaar_sellable: true,
    });
    bazaarOnly++;
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

  log.info({ item_count: processedItems.length, hypixel_items: response.items.length, bazaar_only: bazaarOnly }, 'Items updated (new content)');
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
