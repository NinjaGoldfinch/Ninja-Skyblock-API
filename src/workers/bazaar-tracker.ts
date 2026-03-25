import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet, cacheSetBulk } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { publish } from '../services/event-bus.js';
import { env } from '../config/env.js';
import type { HypixelBazaarProduct, HypixelBazaarResponse } from '../types/hypixel.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('bazaar-tracker');
const QUEUE_NAME = 'bazaar-tracker';

// In-memory state
let previousSnapshot = new Map<string, BazaarProductData>();
let lastModifiedHeader: string | undefined;

interface RawSnapshotRow {
  item_id: string;
  raw_data: Record<string, unknown>; // JSONB object — PostgREST serializes it
}

// Processed data for the warm cache and API responses
export interface BazaarProductData {
  item_id: string;
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

function transformProduct(productId: string, product: HypixelBazaarProduct): BazaarProductData {
  const qs = product.quick_status;

  return {
    item_id: productId,
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

async function processBazaarJob(_job: Job): Promise<void> {
  const startTime = Date.now();

  // Conditional fetch — skip processing if data hasn't changed
  const result = await fetchConditional<HypixelBazaarResponse>(
    { endpoint: '/v2/skyblock/bazaar' },
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

  const products = Object.entries(response.products);
  const snapshotRows: RawSnapshotRow[] = [];
  const cacheEntries: Array<{ id: string; data: BazaarProductData }> = [];
  const rawCacheEntries: Array<{ id: string; data: Record<string, unknown> }> = [];
  const newSnapshot = new Map<string, BazaarProductData>();
  let alertsPublished = 0;

  for (const [productId, product] of products) {
    const data = transformProduct(productId, product);
    newSnapshot.set(productId, data);
    cacheEntries.push({ id: productId, data });
    rawCacheEntries.push({ id: productId, data: product as unknown as Record<string, unknown> });

    // Store raw Hypixel data in Postgres
    snapshotRows.push({
      item_id: productId,
      raw_data: product as unknown as Record<string, unknown>,
    });

    // Compare against in-memory previous snapshot for alerts
    const previous = previousSnapshot.get(productId);
    if (previous) {
      const absDiff = Math.abs(data.instant_buy_price - previous.instant_buy_price);
      if (absDiff >= env.BAZAAR_ALERT_THRESHOLD) {
        const changePct = previous.instant_buy_price > 0
          ? Math.round((absDiff / previous.instant_buy_price) * 1000000) / 10000
          : 0;
        await publish('bazaar:alerts', {
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
        });
        alertsPublished++;
      }
    }
  }

  // Update in-memory snapshot for next poll
  previousSnapshot = newSnapshot;

  // Bulk write processed + raw data to warm cache using Hypixel's lastUpdated
  const lastUpdated = response.lastUpdated;
  await cacheSetBulk('warm', 'bazaar', cacheEntries, lastUpdated);
  await cacheSetBulk('warm', 'bazaar-raw', rawCacheEntries, lastUpdated);

  // Store full raw response as single key for bulk reads
  await cacheSet('warm', 'bazaar-all', 'latest', response.products, lastUpdated);

  // Bulk insert raw snapshots into Postgres
  if (snapshotRows.length > 0) {
    try {
      await postgrestInsert('bazaar_snapshots', snapshotRows);
    } catch (err) {
      log.error({ err }, 'Failed to insert bazaar snapshots into PostgREST');
    }
  }

  log.info({
    products_updated: products.length,
    alerts_published: alertsPublished,
    duration_ms: Date.now() - startTime,
  }, 'Bazaar poll complete');
}

export function startBazaarTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 1s — conditional fetch skips processing when data hasn't changed
  queue.upsertJobScheduler(
    'bazaar-poll',
    { every: 1000 },
    { name: 'bazaar-poll' },
  );

  createWorker(QUEUE_NAME, processBazaarJob);

  // Fetch immediately on startup
  queue.add('bazaar-poll-immediate', {}, { priority: 1 });
}
