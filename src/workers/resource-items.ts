import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheRefreshTtl } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { contentHash } from '../utils/content-hash.js';
import { createLogger } from '../utils/logger.js';
import { decodeSkinUrl, parseColor, classifyTextureType, fetchNeuTextures } from '../utils/texture.js';
import type { HypixelItemsResponse } from '../types/hypixel.js';
import { formatProductId } from './bazaar-tracker.js';

const log = createLogger('resource-items');
const QUEUE_NAME = 'resource-items';

let lastModifiedHeader: string | undefined;
let lastContentHash: string | undefined;
let lastTtlRefresh = 0;

export interface ItemTextureData {
  material: string;
  durability?: number;
  skin_url?: string;
  color?: [number, number, number];
  item_model?: string;
  glowing?: boolean;
}

export type TextureType = 'vanilla' | 'skull' | 'leather' | 'item_model';

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
  texture_type: TextureType;
  texture_data: ItemTextureData;
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
      await cacheRefreshTtl('warm', 'resources', 'item-id-to-meta');
      await cacheRefreshTtl('warm', 'resources', 'item-name-to-id');
      await cacheRefreshTtl('warm', 'resources', 'item-known-names');
      await cacheRefreshTtl('warm', 'resources', 'bazaar-product-ids');
      await cacheRefreshTtl('warm', 'resources', 'seen-auction-items');
      await cacheRefreshTtl('warm', 'resources', 'item-textures');
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
  const idToMeta: Record<string, { name: string; category?: string; tier?: string }> = {};

  const processedItems: ProcessedItem[] = [];

  for (const item of response.items) {
    const name = stripColorCodes(item.name);
    idToName[item.id] = name;
    nameToId[name] = item.id;
    knownNames.add(name);
    idToMeta[item.id] = { name, category: item.category, tier: item.tier };

    const textureType = classifyTextureType(item);
    const textureData: ItemTextureData = { material: item.material };
    if (item.durability !== undefined) textureData.durability = item.durability;
    if (item.glowing) textureData.glowing = true;
    if (item.item_model) textureData.item_model = item.item_model;
    if (textureType === 'skull' && item.skin) textureData.skin_url = decodeSkinUrl(item.skin);
    if (textureType === 'leather' && item.color) textureData.color = parseColor(item.color);

    processedItems.push({
      id: item.id,
      name,
      material: item.material,
      tier: item.tier,
      category: item.category,
      npc_sell_price: item.npc_sell_price,
      museum: item.museum,
      texture_type: textureType,
      texture_data: textureData,
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

  // Add bazaar-only items not in the Hypixel items resource (e.g. enchantments, essences, shards)
  const bazaarOnlyIds = [...bazaarSet].filter((id) => !existingIds.has(id));

  // Fetch NEU textures for non-enchantment bazaar-only items (enchantments are always books)
  const neuCandidates = bazaarOnlyIds.filter((id) => !id.startsWith('ENCHANTMENT_'));
  const neuTextures = neuCandidates.length > 0
    ? await fetchNeuTextures(neuCandidates)
    : new Map<string, { material: string; durability?: number; skin_url?: string }>();

  let bazaarOnly = 0;
  for (const productId of bazaarOnlyIds) {
    const name = formatProductId(productId);
    idToName[productId] = name;
    nameToId[name] = productId;
    knownNames.add(name);

    const neuData = neuTextures.get(productId);

    if (productId.startsWith('ENCHANTMENT_')) {
      // Enchantment books
      processedItems.push({
        id: productId, name, material: 'ENCHANTED_BOOK', is_bazaar_sellable: true,
        texture_type: 'vanilla',
        texture_data: { material: 'ENCHANTED_BOOK', glowing: true },
      });
    } else if (neuData?.skin_url) {
      // NEU provided a skull texture (essences, etc.)
      processedItems.push({
        id: productId, name, material: 'SKULL_ITEM', is_bazaar_sellable: true,
        texture_type: 'skull',
        texture_data: { material: 'SKULL_ITEM', durability: 3, skin_url: neuData.skin_url },
      });
    } else if (productId.startsWith('SHARD_')) {
      // Bestiary mob shards — use prismarine shard as visual fallback
      processedItems.push({
        id: productId, name, material: 'PRISMARINE_SHARD', is_bazaar_sellable: true,
        texture_type: 'vanilla',
        texture_data: { material: 'PRISMARINE_SHARD' },
      });
    } else if (productId.startsWith('ESSENCE_')) {
      // Essence without NEU data — use nether star as fallback
      processedItems.push({
        id: productId, name, material: 'NETHER_STAR', is_bazaar_sellable: true,
        texture_type: 'vanilla',
        texture_data: { material: 'NETHER_STAR' },
      });
    } else {
      // Unknown bazaar-only item
      processedItems.push({
        id: productId, name, material: 'PAPER', is_bazaar_sellable: true,
        texture_type: 'vanilla',
        texture_data: { material: 'PAPER' },
      });
    }
    bazaarOnly++;
  }

  // Build compact texture map for the bulk endpoint
  const textureMap: Record<string, ItemTextureData & { type: TextureType }> = {};
  for (const item of processedItems) {
    textureMap[item.id] = { type: item.texture_type, ...item.texture_data };
  }

  // Cache everything
  const ts = response.lastUpdated;
  await cacheSet('warm', 'resources', 'items', processedItems, ts);
  await cacheSet('warm', 'resources', 'items-raw', response.items, ts);
  await cacheSet('warm', 'resources', 'item-id-to-name', idToName, ts);
  await cacheSet('warm', 'resources', 'item-id-to-meta', idToMeta, ts);
  await cacheSet('warm', 'resources', 'item-name-to-id', nameToId, ts);
  await cacheSet('warm', 'resources', 'item-known-names', Array.from(knownNames), ts);
  await cacheSet('warm', 'resources', 'item-textures', textureMap, ts);

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
