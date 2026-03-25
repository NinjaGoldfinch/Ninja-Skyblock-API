import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchBazaar } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { env } from '../config/env.js';
import type { HypixelBazaarProduct } from '../types/hypixel.js';

const QUEUE_NAME = 'bazaar-tracker';

interface BazaarSnapshotRow {
  item_id: string;
  buy_price: number;
  sell_price: number;
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  buy_moving_week: number;
  sell_moving_week: number;
}

interface BazaarProductData {
  item_id: string;
  buy_price: number;
  sell_price: number;
  buy_volume: number;
  sell_volume: number;
  buy_orders: number;
  sell_orders: number;
  buy_moving_week: number;
  sell_moving_week: number;
}

function transformProduct(productId: string, product: HypixelBazaarProduct): BazaarProductData {
  const qs = product.quick_status;
  return {
    item_id: productId,
    buy_price: qs.buyPrice,
    sell_price: qs.sellPrice,
    buy_volume: qs.buyVolume,
    sell_volume: qs.sellVolume,
    buy_orders: qs.buyOrders,
    sell_orders: qs.sellOrders,
    buy_moving_week: qs.buyMovingWeek,
    sell_moving_week: qs.sellMovingWeek,
  };
}

async function processBazaarJob(_job: Job): Promise<void> {
  const response = await fetchBazaar();
  if (!response.success) return;

  const products = Object.entries(response.products);
  const snapshotRows: BazaarSnapshotRow[] = [];

  for (const [productId, product] of products) {
    const data = transformProduct(productId, product);
    snapshotRows.push(data);

    // Update warm cache for each product
    await cacheSet('warm', 'bazaar', productId, data);
  }

  // Bulk insert snapshots into Postgres via PostgREST
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

  // Schedule repeating job
  queue.upsertJobScheduler(
    'bazaar-poll',
    { every: env.BAZAAR_POLL_INTERVAL },
    { name: 'bazaar-poll' },
  );

  // Create worker to process jobs
  createWorker(QUEUE_NAME, processBazaarJob);
}
