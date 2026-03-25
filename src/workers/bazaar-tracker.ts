import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchBazaar } from '../services/hypixel-client.js';
import { cacheGet, cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { publish } from '../services/event-bus.js';
import { env } from '../config/env.js';
import type { HypixelBazaarProduct } from '../types/hypixel.js';

const QUEUE_NAME = 'bazaar-tracker';

interface RawSnapshotRow {
  item_id: string;
  raw_data: string; // JSONB — PostgREST accepts stringified JSON
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
  const response = await fetchBazaar();
  if (!response.success) return;

  const products = Object.entries(response.products);
  const snapshotRows: RawSnapshotRow[] = [];

  for (const [productId, product] of products) {
    const data = transformProduct(productId, product);

    // Store raw Hypixel data in Postgres
    snapshotRows.push({
      item_id: productId,
      raw_data: JSON.stringify(product),
    });

    // Check previous price for alert publishing
    const previous = await cacheGet<BazaarProductData>('warm', 'bazaar', productId);
    if (previous) {
      const absDiff = Math.abs(data.instant_buy_price - previous.data.instant_buy_price);
      if (absDiff >= env.BAZAAR_ALERT_THRESHOLD) {
        const changePct = previous.data.instant_buy_price > 0
          ? Math.round((absDiff / previous.data.instant_buy_price) * 10000) / 100
          : 0;
        await publish('bazaar:alerts', {
          type: 'bazaar:price_change',
          item_id: productId,
          old_buy_price: previous.data.instant_buy_price,
          new_buy_price: data.instant_buy_price,
          old_sell_price: previous.data.instant_sell_price,
          new_sell_price: data.instant_sell_price,
          change_pct: changePct,
          timestamp: Date.now(),
        });
      }
    }

    // Update warm cache with processed data
    await cacheSet('warm', 'bazaar', productId, data);
  }

  // Bulk insert raw snapshots into Postgres
  if (snapshotRows.length > 0) {
    try {
      await postgrestInsert('bazaar_snapshots', snapshotRows);
    } catch {
      // PostgREST may not be available yet — don't crash the worker
    }
  }
}

export function startBazaarTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'bazaar-poll',
    { every: env.BAZAAR_POLL_INTERVAL },
    { name: 'bazaar-poll' },
  );

  createWorker(QUEUE_NAME, processBazaarJob);
}
