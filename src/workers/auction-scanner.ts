import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchAuctionsPage } from '../services/hypixel-client.js';
import { cacheSetBulk } from '../services/cache-manager.js';
import { publish } from '../services/event-bus.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelAuction } from '../types/hypixel.js';

const log = createLogger('auction-scanner');
const QUEUE_NAME = 'auction-scanner';

const ENDING_SOON_WINDOW_MS = 120_000; // 2 minutes

export interface LowestBinData {
  item_name: string;
  price: number;
  auction_id: string;
  seller_uuid: string;
  ends_at: number;
}

// In-memory previous lowest BINs for change detection
let previousLowestBins = new Map<string, LowestBinData>();

async function processAuctionJob(_job: Job): Promise<void> {
  const startTime = Date.now();

  // Fetch first page to get totalPages
  const firstPage = await fetchAuctionsPage(0);
  if (!firstPage.success) {
    log.warn('Auction fetch returned success=false');
    return;
  }

  // Collect all BIN auctions across all pages
  const allBinAuctions: HypixelAuction[] = [];
  const endingSoon: HypixelAuction[] = [];
  const now = Date.now();

  // Process first page
  for (const auction of firstPage.auctions) {
    if (auction.bin) {
      allBinAuctions.push(auction);
    }
    if (auction.end - now <= ENDING_SOON_WINDOW_MS && auction.end > now) {
      endingSoon.push(auction);
    }
  }

  // Fetch remaining pages
  for (let page = 1; page < firstPage.totalPages; page++) {
    try {
      const pageData = await fetchAuctionsPage(page);
      if (!pageData.success) continue;
      for (const auction of pageData.auctions) {
        if (auction.bin) {
          allBinAuctions.push(auction);
        }
        if (auction.end - now <= ENDING_SOON_WINDOW_MS && auction.end > now) {
          endingSoon.push(auction);
        }
      }
    } catch (err) {
      log.warn({ page, err }, 'Failed to fetch auction page');
    }
  }

  // Find lowest BIN per item
  const lowestBins = new Map<string, LowestBinData>();
  for (const auction of allBinAuctions) {
    const itemKey = auction.item_name;
    const existing = lowestBins.get(itemKey);
    if (!existing || auction.starting_bid < existing.price) {
      lowestBins.set(itemKey, {
        item_name: auction.item_name,
        price: auction.starting_bid,
        auction_id: auction.uuid,
        seller_uuid: auction.auctioneer,
        ends_at: auction.end,
      });
    }
  }

  // Publish alerts for new lowest BINs
  let alertsPublished = 0;
  for (const [itemName, data] of lowestBins) {
    const previous = previousLowestBins.get(itemName);
    if (previous && data.price < previous.price) {
      await publish('auction:alerts', {
        type: 'auction:new_lowest_bin',
        item_id: itemName,
        item_name: itemName,
        price: data.price,
        auction_id: data.auction_id,
        timestamp: Date.now(),
      });
      alertsPublished++;
    }
  }

  // Publish ending soon events
  for (const auction of endingSoon) {
    await publish('auction:ending', {
      type: 'auction:ending_soon',
      item_id: auction.item_name,
      item_name: auction.item_name,
      price: auction.bin ? auction.starting_bid : auction.highest_bid_amount,
      auction_id: auction.uuid,
      ends_at: auction.end,
      timestamp: Date.now(),
    });
  }

  // Update cache with lowest BINs
  const cacheEntries = Array.from(lowestBins.entries()).map(([itemName, data]) => ({
    id: itemName,
    data,
  }));
  if (cacheEntries.length > 0) {
    await cacheSetBulk('hot', 'auction-lowest', cacheEntries);
  }

  previousLowestBins = lowestBins;

  log.info({
    total_auctions: firstPage.totalAuctions,
    pages: firstPage.totalPages,
    bin_auctions: allBinAuctions.length,
    unique_items: lowestBins.size,
    ending_soon: endingSoon.length,
    alerts_published: alertsPublished,
    duration_ms: Date.now() - startTime,
  }, 'Auction scan complete');
}

export function startAuctionScanner(): void {
  const queue = getQueue(QUEUE_NAME);

  queue.upsertJobScheduler(
    'auction-scan',
    { every: env.AUCTION_POLL_INTERVAL },
    { name: 'auction-scan' },
  );

  createWorker(QUEUE_NAME, processAuctionJob);
}
