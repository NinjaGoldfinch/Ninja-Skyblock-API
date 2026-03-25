import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchConditional } from '../services/hypixel-client.js';
import { cacheSet } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelEndedAuctionsResponse, HypixelEndedAuction } from '../types/hypixel.js';

const log = createLogger('auction-sold');
const QUEUE_NAME = 'auction-sold';

let lastModifiedHeader: string | undefined;

interface AuctionSaleRow {
  auction_id: string;
  item_id: string;
  item_name: string;
  price: number;
  seller_uuid: string;
  buyer_uuid: string | null;
  bin: boolean;
  ended_at: string;
}

function toSaleRow(auction: HypixelEndedAuction): AuctionSaleRow {
  return {
    auction_id: auction.auction_id,
    item_id: auction.auction_id, // No clean item ID available without NBT parsing
    item_name: auction.auction_id,
    price: auction.price,
    seller_uuid: auction.seller,
    buyer_uuid: auction.buyer || null,
    bin: auction.bin,
    ended_at: new Date(auction.timestamp).toISOString(),
  };
}

async function processAuctionSoldJob(_job: Job): Promise<void> {
  const startTime = Date.now();

  const result = await fetchConditional<HypixelEndedAuctionsResponse>(
    { endpoint: '/v2/skyblock/auctions_ended' },
    lastModifiedHeader,
  );

  if (!result.modified) {
    log.trace('Ended auctions data unchanged, skipping');
    return;
  }

  const response = result.data!;
  lastModifiedHeader = result.lastModified ?? lastModifiedHeader;

  if (!response.success) {
    log.warn('Ended auctions fetch returned success=false');
    return;
  }

  const auctions = response.auctions;

  // Cache the latest ended auctions
  await cacheSet('hot', 'auctions-ended', 'latest', auctions, response.lastUpdated);

  // Store in Postgres
  if (auctions.length > 0) {
    const rows = auctions.map(toSaleRow);
    try {
      await postgrestInsert('auction_sales', rows, 'auction_id');
    } catch (err) {
      log.error({ err }, 'Failed to insert auction sales into PostgREST');
    }
  }

  log.info({
    auctions_ended: auctions.length,
    bin_sales: auctions.filter((a) => a.bin).length,
    duration_ms: Date.now() - startTime,
  }, 'Auction sold poll complete');
}

export function startAuctionSoldTracker(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 1s — conditional fetch skips when unchanged
  queue.upsertJobScheduler(
    'auction-sold-poll',
    { every: 1000 },
    { name: 'auction-sold-poll' },
  );

  createWorker(QUEUE_NAME, processAuctionSoldJob);

  queue.add('auction-sold-immediate', {}, { priority: 1 });
}
