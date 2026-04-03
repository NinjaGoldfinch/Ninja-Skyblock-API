import { fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheSetPipeline } from '../services/cache-manager.js';
import type { CachePipelineEntry } from '../services/cache-manager.js';
import { postgrestInsert, postgrestRpc } from '../services/postgrest-client.js';
import { publishBatch } from '../services/event-bus.js';
import type { EventChannel, EventPayload } from '../services/event-bus.js';
import { env } from '../config/env.js';
import type { HypixelBazaarProduct, HypixelBazaarResponse } from '../types/hypixel.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bazaar-tracker');

// In-memory state
let previousSnapshot = new Map<string, BazaarProductData>();
let lastModifiedHeader: string | undefined;
let snapshotsSinceLastInsert = 0;
const BAZAAR_INSERT_INTERVAL = 5; // Insert to Postgres every Nth update (skip unchanged cycles)

interface SnapshotRow {
  item_id: string;
  instant_buy: number;
  instant_sell: number;
  avg_buy: number;
  avg_sell: number;
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  buy_moving_week: number;
  sell_moving_week: number;
}

// Bazaar tax rate: 1.125% on instant-buy orders
const BAZAAR_TAX_RATE = 0.01125;

// Processed data for the warm cache and API responses
export interface BazaarProductData {
  item_id: string;
  display_name: string | null;  // Display name from items resource, null if not found
  category: string;             // Derived bazaar category (e.g. "enchantment", "essence", "sword", "enchanted_material")
  tier: string | null;          // Item tier/rarity from items resource (e.g. "COMMON", "RARE")
  instant_buy_price: number;   // what user pays to buy now (cheapest ask)
  instant_sell_price: number;  // what user gets selling now (highest bid)
  avg_buy_price: number;       // average cost to buy (weighted avg of asks)
  avg_sell_price: number;      // average revenue selling (weighted avg of bids)
  buy_volume: number;          // supply available to buy from (ask-side volume)
  sell_volume: number;         // demand to sell into (bid-side volume)
  buy_orders: number;          // number of offers to buy from (ask-side orders)
  sell_orders: number;         // number of offers to sell to (bid-side orders)
  buy_moving_week: number;     // items instant-bought past 7 days
  sell_moving_week: number;    // items instant-sold past 7 days
  margin: number;              // sell - buy (positive = profitable flip)
  margin_percent: number;      // margin / buy_price * 100
  tax_adjusted_margin: number; // margin after 1.125% bazaar tax on buy side
  top_buy_orders: Array<{ amount: number; price_per_unit: number; orders: number }>;
  top_sell_orders: Array<{ amount: number; price_per_unit: number; orders: number }>;
}

const ROMAN_NUMERALS: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X' };

/** Convert a SCREAMING_SNAKE_CASE product ID to a readable display name as a fallback. */
export function formatProductId(productId: string): string {
  let id = productId;

  // ENCHANTMENT_ULTIMATE_CHIMERA_5 → "Chimera V"
  // ENCHANTMENT_SHARPNESS_7 → "Sharpness VII"
  if (id.startsWith('ENCHANTMENT_ULTIMATE_')) {
    id = id.slice('ENCHANTMENT_ULTIMATE_'.length);
    return formatWords(id, true);
  }
  if (id.startsWith('ENCHANTMENT_')) {
    id = id.slice('ENCHANTMENT_'.length);
    return formatWords(id, true);
  }

  // ESSENCE_DRAGON → "Dragon Essence"
  if (id.startsWith('ESSENCE_')) {
    const type = id.slice('ESSENCE_'.length);
    return titleCase(type) + ' Essence';
  }

  return formatWords(id, false);
}

function formatWords(id: string, enchantment: boolean): string {
  const parts = id.split('_');

  const result = parts.map(titleCase);

  // For enchantments, convert trailing number to roman numeral
  if (enchantment && result.length > 0) {
    const num = parseInt(parts[parts.length - 1]!);
    if (!isNaN(num) && ROMAN_NUMERALS[num]) {
      result[result.length - 1] = ROMAN_NUMERALS[num]!;
    }
  }

  return result.join(' ');
}

function titleCase(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

interface ItemMeta {
  name?: string;
  category?: string;
  tier?: string;
}

/** Derive a meaningful bazaar category from the product ID pattern and item metadata. */
function deriveBazaarCategory(productId: string, itemCategory?: string): string {
  // Use item-ID prefix patterns for bazaar-specific categories
  if (productId.startsWith('ENCHANTMENT_ULTIMATE_')) return 'ultimate_enchantment';
  if (productId.startsWith('ENCHANTMENT_')) return 'enchantment';
  if (productId.startsWith('ESSENCE_')) return 'essence';
  if (productId.startsWith('SHARD_')) return 'shard';

  // Map Hypixel item categories to lowercase bazaar categories
  if (itemCategory) return itemCategory.toLowerCase();

  // Fallback heuristics for uncategorized items
  if (productId.startsWith('ENCHANTED_')) return 'enchanted_material';
  if (productId.includes('_LOG') || productId.includes('_BLOCK') || productId.includes('_ORE')) return 'raw_material';

  return 'other';
}

function transformProduct(productId: string, product: HypixelBazaarProduct, itemMeta?: Record<string, ItemMeta>): BazaarProductData {
  const qs = product.quick_status;
  const meta = itemMeta?.[productId];

  // All "buy_*" fields = user buying action, all "sell_*" fields = user selling action.
  // Hypixel inverts this: their sell_summary = asks (what user buys from),
  // their buy_summary = bids (what user sells to). We swap to user perspective.

  // Instant prices from actual order book — no quick_status fallback.
  const cheapestAsk = product.sell_summary[0]?.pricePerUnit ?? 0; // what user pays to buy
  const highestBid = product.buy_summary[0]?.pricePerUnit ?? 0;   // what user gets selling
  const instantBuy = cheapestAsk;
  const instantSell = instantBuy > 0 ? highestBid : 0; // zero if no sell orders exist

  // Margin = profit from flipping (positive = profitable)
  const margin = instantSell - instantBuy;
  const marginPercent = instantBuy > 0 ? Math.round((margin / instantBuy) * 10000) / 100 : 0;
  const taxAdjustedMargin = Math.round((instantSell - instantBuy * (1 + BAZAAR_TAX_RATE)) * 100) / 100;

  return {
    item_id: productId,
    display_name: meta?.name ?? formatProductId(productId),
    category: deriveBazaarCategory(productId, meta?.category),
    tier: meta?.tier ?? null,
    instant_buy_price: instantBuy,                  // cheapest ask (what user pays)
    instant_sell_price: instantSell,                // highest bid (what user gets)
    avg_buy_price: qs.sellPrice,                    // avg of asks (avg cost to buy)
    avg_sell_price: qs.buyPrice,                    // avg of bids (avg revenue selling)
    buy_volume: qs.sellVolume,                      // supply available to buy from
    sell_volume: qs.buyVolume,                      // demand to sell into
    buy_orders: qs.sellOrders,                      // number of offers to buy from
    sell_orders: qs.buyOrders,                      // number of offers to sell to
    buy_moving_week: qs.buyMovingWeek,              // items instant-bought past 7d (already user POV)
    sell_moving_week: qs.sellMovingWeek,            // items instant-sold past 7d (already user POV)
    margin: Math.round(margin * 100) / 100,
    margin_percent: marginPercent,
    tax_adjusted_margin: taxAdjustedMargin,
    top_buy_orders: product.sell_summary.slice(0, 10).map((o) => ({  // asks (orders user buys from)
      amount: o.amount,
      price_per_unit: o.pricePerUnit,
      orders: o.orders,
    })),
    top_sell_orders: product.buy_summary.slice(0, 10).map((o) => ({  // bids (orders user sells to)
      amount: o.amount,
      price_per_unit: o.pricePerUnit,
      orders: o.orders,
    })),
  };
}

async function processBazaarJob(): Promise<void> {
  const startTime = Date.now();

  // Conditional fetch — skip processing if data hasn't changed
  const result = await fetchConditional<HypixelBazaarResponse>(
    { endpoint: '/v2/skyblock/bazaar', noApiKey: true },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Bazaar data unchanged, skipping');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) {
    log.warn('Bazaar fetch returned success=false');
    return;
  }

  const fetchMs = Date.now() - startTime;

  const products = Object.entries(response.products);
  const snapshotRows: SnapshotRow[] = [];
  const newSnapshot = new Map<string, BazaarProductData>();
  const eventBatch: Array<{ channel: EventChannel; event: EventPayload }> = [];
  let alertsPublished = 0;
  let newProducts = 0;

  // --- Fetch item metadata for display_name/category/tier enrichment ---
  const idToMetaCache = await cacheGet<Record<string, ItemMeta>>('warm', 'resources', 'item-id-to-meta');
  const itemMeta = idToMetaCache?.data;

  // --- Collect cache ops into a single pipeline ---
  const lastUpdated = response.lastUpdated;
  const cacheOps: CachePipelineEntry[] = [];

  for (const [productId, product] of products) {
    const data = transformProduct(productId, product, itemMeta);
    newSnapshot.set(productId, data);

    cacheOps.push({ tier: 'warm', resource: 'bazaar', id: productId, data, dataTimestamp: lastUpdated });
    cacheOps.push({ tier: 'warm', resource: 'bazaar-raw', id: productId, data: product as unknown as Record<string, unknown>, dataTimestamp: lastUpdated });

    snapshotRows.push({
      item_id: productId,
      instant_buy: data.instant_buy_price,
      instant_sell: data.instant_sell_price,
      avg_buy: data.avg_buy_price,
      avg_sell: data.avg_sell_price,
      buy_volume: data.buy_volume,
      sell_volume: data.sell_volume,
      buy_orders: data.buy_orders,
      sell_orders: data.sell_orders,
      buy_moving_week: data.buy_moving_week,
      sell_moving_week: data.sell_moving_week,
    });

    // Compare against in-memory previous snapshot for alerts
    const previous = previousSnapshot.get(productId);
    if (!previous) {
      newProducts++;
    } else {
      const absDiff = Math.abs(data.instant_buy_price - previous.instant_buy_price);
      if (absDiff >= env.BAZAAR_ALERT_THRESHOLD) {
        const changePct = previous.instant_buy_price > 0
          ? Math.round((absDiff / previous.instant_buy_price) * 1000000) / 10000
          : 0;
        eventBatch.push({ channel: 'bazaar:alerts', event: {
          type: 'bazaar:price_change',
          item_id: productId,
          old_instant_buy_price: previous.instant_buy_price,
          new_instant_buy_price: data.instant_buy_price,
          old_instant_sell_price: previous.instant_sell_price,
          new_instant_sell_price: data.instant_sell_price,
          old_avg_buy_price: previous.avg_buy_price,
          new_avg_buy_price: data.avg_buy_price,
          old_avg_sell_price: previous.avg_sell_price,
          new_avg_sell_price: data.avg_sell_price,
          change_pct: changePct,
          timestamp: Date.now(),
        }});
        alertsPublished++;
      }
    }
  }

  // Update in-memory snapshot for next poll
  previousSnapshot = newSnapshot;

  // Full raw response as single key for bulk reads
  cacheOps.push({ tier: 'warm', resource: 'bazaar-all', id: 'latest', data: response.products, dataTimestamp: lastUpdated });

  // All processed products as single key for v2 bulk endpoint
  const allProcessed = Array.from(newSnapshot.values());
  cacheOps.push({ tier: 'warm', resource: 'bazaar-products', id: 'latest', data: allProcessed, dataTimestamp: lastUpdated });

  // Cache bazaar product IDs for resource-items worker to set is_bazaar_sellable flags
  const bazaarProductIds = Object.keys(response.products);
  await cacheSet('warm', 'resources', 'bazaar-product-ids', bazaarProductIds, lastUpdated);

  // Fire cache pipeline, event publishes, and Postgres insert concurrently
  // Only insert to Postgres if there were alerts or on periodic interval (reduces DB load)
  snapshotsSinceLastInsert++;
  const shouldInsert = alertsPublished > 0 || snapshotsSinceLastInsert >= BAZAAR_INSERT_INTERVAL;
  await Promise.all([
    cacheSetPipeline(cacheOps),
    eventBatch.length > 0 ? publishBatch(eventBatch) : undefined,
    shouldInsert && snapshotRows.length > 0
      ? postgrestInsert('bazaar_snapshots', snapshotRows)
          .then(() => { snapshotsSinceLastInsert = 0; })
          .catch((err) => log.error({ err }, 'Failed to insert bazaar snapshots'))
      : undefined,
  ]);

  const totalMs = Date.now() - startTime;
  const newTag = newProducts > 0 ? ` +${newProducts} new` : '';
  log.info(`Bazaar | products:${products.length}${newTag} alerts:${alertsPublished} | fetch:${fetchMs}ms total:${totalMs}ms`);
}

export function startBazaarTracker(): void {
  let running = false;

  // Fetch immediately on startup
  void processBazaarJob().catch((err) => log.error({ err }, 'Initial bazaar fetch failed'));

  // Poll every 1s with mutex to prevent overlapping runs
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processBazaarJob();
    } catch (err) {
      log.error({ err }, 'Bazaar poll failed');
    } finally {
      running = false;
    }
  }, 1000);

  // Hourly aggregation + retention (run every 10 minutes, offset by 30s to avoid poll contention)
  setTimeout(() => {
    void runAggregationAndRetention();
    setInterval(() => void runAggregationAndRetention(), 10 * 60 * 1000);
  }, 30_000);
}

async function runAggregationAndRetention(): Promise<void> {
  try {
    await postgrestRpc<void>('bazaar_aggregate_and_retain', {});
    log.info('Bazaar aggregation + retention completed');
  } catch (err) {
    log.error({ err }, 'Bazaar aggregation + retention failed');
  }
}
