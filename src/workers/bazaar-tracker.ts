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

// Processed data for the warm cache and API responses
export interface BazaarProductData {
  item_id: string;
  display_name: string | null;  // Display name from items resource, null if not found
  instant_buy_price: number;   // cheapest sell order (what you pay to buy now)
  instant_sell_price: number;  // highest buy order (what you get selling now)
  avg_buy_price: number;       // weighted average from quick_status
  avg_sell_price: number;      // weighted average from quick_status
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  buy_moving_week: number;
  sell_moving_week: number;
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

function transformProduct(productId: string, product: HypixelBazaarProduct, idToName?: Record<string, string>): BazaarProductData {
  const qs = product.quick_status;

  return {
    item_id: productId,
    display_name: idToName?.[productId] ?? formatProductId(productId),
    instant_buy_price: product.sell_summary[0]?.pricePerUnit ?? qs.buyPrice,
    instant_sell_price: product.buy_summary[0]?.pricePerUnit ?? qs.sellPrice,
    avg_buy_price: qs.buyPrice,
    avg_sell_price: qs.sellPrice,
    buy_volume: qs.buyVolume,
    sell_volume: qs.sellVolume,
    buy_orders: qs.buyOrders,
    sell_orders: qs.sellOrders,
    buy_moving_week: qs.buyMovingWeek,
    sell_moving_week: qs.sellMovingWeek,
    top_buy_orders: product.buy_summary.slice(0, 10).map((o) => ({
      amount: o.amount,
      price_per_unit: o.pricePerUnit,
      orders: o.orders,
    })),
    top_sell_orders: product.sell_summary.slice(0, 10).map((o) => ({
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

  // --- Fetch item name lookup for display_name enrichment ---
  const idToNameCache = await cacheGet<Record<string, string>>('warm', 'resources', 'item-id-to-name');
  const idToName = idToNameCache?.data;

  // --- Collect cache ops into a single pipeline ---
  const lastUpdated = response.lastUpdated;
  const cacheOps: CachePipelineEntry[] = [];

  for (const [productId, product] of products) {
    const data = transformProduct(productId, product, idToName);
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
