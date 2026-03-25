import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchAuctionsPage, fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheSetBulk } from '../services/cache-manager.js';
import { publish } from '../services/event-bus.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelAuction, HypixelAuctionsPageResponse } from '../types/hypixel.js';

const log = createLogger('auction-scanner');
const QUEUE_NAME = 'auction-scanner';

const ENDING_SOON_WINDOW_MS = 120_000; // 2 minutes

// In-memory state
let lastModifiedHeader: string | undefined;
let knownItemNames: Set<string> = new Set();

// --- Tracked auction types ---

export interface TrackedAuction {
  auction_id: string;
  base_item: string;
  skyblock_id: string | null;
  item_name: string;
  price: number;
  starting_bid: number;
  highest_bid: number;
  seller_uuid: string;
  ends_at: number;
  tier: string;
  category: string;
  bin: boolean;
}

export interface AuctionItemData {
  item_name: string;
  price: number;
  auction_id: string;
  seller_uuid: string;
  ends_at: number;
  tier: string;
  category: string;
}

export interface LowestBinData {
  skyblock_id: string | null;
  base_item: string;
  lowest: AuctionItemData;
  listings: AuctionItemData[];
  count: number;
}

// --- Master auction state ---

// All auctions keyed by UUID
const allTracked = new Map<string, TrackedAuction>();

// Derived views (rebuilt after each diff)
const binAuctions = new Map<string, TrackedAuction>();      // Only BIN auctions
const regularAuctions = new Map<string, TrackedAuction>();   // Only regular (bid) auctions

// Previous lowest BINs for alert detection
let previousLowestBins = new Map<string, LowestBinData>();

// --- Helpers ---

function stripFormatting(itemName: string): string {
  let name = itemName;
  name = name.replace(/^[^\w\[]+/, '');
  name = name.replace(/^\[Lvl \d+\]\s*/, '');
  name = name.replace(/^\[\d+[^\]]*\]\s*/, '');
  name = name.replace(/[\s✪✦➊➋➌➍➎⚚]+$/g, '').trim();
  if (name.startsWith('Shiny ')) name = name.slice(6);
  return name.trim();
}

function extractBaseItem(itemName: string): string {
  const stripped = stripFormatting(itemName);
  if (knownItemNames.has(stripped)) return stripped;
  const firstSpace = stripped.indexOf(' ');
  if (firstSpace > 0) {
    const withoutFirst = stripped.slice(firstSpace + 1);
    if (knownItemNames.has(withoutFirst)) return withoutFirst;
  }
  return stripped;
}

function processNewAuction(auction: HypixelAuction, nameToId: Record<string, string>): TrackedAuction {
  const baseItem = extractBaseItem(auction.item_name);
  return {
    auction_id: auction.uuid,
    base_item: baseItem,
    skyblock_id: nameToId[baseItem] ?? null,
    item_name: auction.item_name,
    price: auction.bin ? auction.starting_bid : auction.highest_bid_amount,
    starting_bid: auction.starting_bid,
    highest_bid: auction.highest_bid_amount,
    seller_uuid: auction.auctioneer,
    ends_at: auction.end,
    tier: auction.tier,
    category: auction.category,
    bin: auction.bin,
  };
}

/**
 * Rebuild the BIN and regular sub-maps from the master map.
 */
function rebuildViews(): void {
  binAuctions.clear();
  regularAuctions.clear();
  for (const [id, auction] of allTracked) {
    if (auction.bin) {
      binAuctions.set(id, auction);
    } else {
      regularAuctions.set(id, auction);
    }
  }
}

/**
 * Build lowest BIN data from the BIN auctions sub-map.
 */
function buildLowestBins(): Map<string, LowestBinData> {
  const itemGroups = new Map<string, TrackedAuction[]>();
  for (const auction of binAuctions.values()) {
    const group = itemGroups.get(auction.base_item);
    if (group) {
      group.push(auction);
    } else {
      itemGroups.set(auction.base_item, [auction]);
    }
  }

  const lowestBins = new Map<string, LowestBinData>();
  for (const [baseItem, auctions] of itemGroups) {
    auctions.sort((a, b) => a.price - b.price);
    const listings: AuctionItemData[] = auctions.slice(0, 20).map((a) => ({
      item_name: a.item_name,
      price: a.price,
      auction_id: a.auction_id,
      seller_uuid: a.seller_uuid,
      ends_at: a.ends_at,
      tier: a.tier,
      category: a.category,
    }));

    lowestBins.set(baseItem, {
      skyblock_id: auctions[0]!.skyblock_id,
      base_item: baseItem,
      lowest: listings[0]!,
      listings,
      count: auctions.length,
    });
  }

  return lowestBins;
}

// --- Main job processor ---

async function processAuctionJob(_job: Job): Promise<void> {
  const startTime = Date.now();

  // Wait for items worker
  const itemNamesCache = await cacheGet<string[]>('warm', 'resources', 'item-known-names');
  if (!itemNamesCache) {
    log.info('Waiting for items worker to cache item names — skipping this cycle');
    return;
  }
  knownItemNames = new Set(itemNamesCache.data);

  const nameToIdCache = await cacheGet<Record<string, string>>('warm', 'resources', 'item-name-to-id');
  const nameToId = nameToIdCache?.data ?? {};

  // Conditional fetch on page 0
  const checkResult = await fetchConditional<HypixelAuctionsPageResponse>(
    { endpoint: '/v2/skyblock/auctions', params: { page: '0' } },
    lastModifiedHeader,
  );

  if (!checkResult.modified) {
    log.trace('Auction data unchanged, skipping');
    return;
  }

  const firstPage = checkResult.data!;
  lastModifiedHeader = checkResult.lastModified ?? lastModifiedHeader;

  if (!firstPage.success) {
    log.warn('Auction fetch returned success=false');
    return;
  }

  // --- Fetch ALL pages before processing ---

  const allRawAuctions: HypixelAuction[] = [];
  const endingSoon: HypixelAuction[] = [];
  const now = Date.now();

  function collectPage(auctions: HypixelAuction[]): void {
    for (const auction of auctions) {
      allRawAuctions.push(auction);
      if (auction.end - now <= ENDING_SOON_WINDOW_MS && auction.end > now) {
        endingSoon.push(auction);
      }
    }
  }

  collectPage(firstPage.auctions);

  const totalRemaining = firstPage.totalPages - 1;
  const PRIORITY_PAGES = 15;
  const priorityCount = Math.min(PRIORITY_PAGES, totalRemaining);
  const remainingCount = totalRemaining - priorityCount;
  const fetchStart = Date.now();
  let pagesSucceeded = 1;

  const priorityPromises = Array.from(
    { length: priorityCount },
    (_, i) => fetchAuctionsPage(i + 1).catch((err) => {
      log.warn({ page: i + 1, err }, 'Failed to fetch auction page');
      return null;
    }),
  );
  const priorityPages = await Promise.all(priorityPromises);
  const priorityDuration = Date.now() - fetchStart;
  for (const pageData of priorityPages) {
    if (pageData?.success) { collectPage(pageData.auctions); pagesSucceeded++; }
  }

  if (remainingCount > 0) {
    const remainingPromises = Array.from(
      { length: remainingCount },
      (_, i) => fetchAuctionsPage(i + 1 + priorityCount).catch((err) => {
        log.warn({ page: i + 1 + priorityCount, err }, 'Failed to fetch auction page');
        return null;
      }),
    );
    const remainingPages = await Promise.all(remainingPromises);
    for (const pageData of remainingPages) {
      if (pageData?.success) { collectPage(pageData.auctions); pagesSucceeded++; }
    }
  }

  const fetchDuration = Date.now() - fetchStart;

  // --- All pages fetched. Diff against tracked state ---

  const newAuctionIds = new Set(allRawAuctions.map((a) => a.uuid));
  let addedCount = 0;
  let removedCount = 0;
  let updatedCount = 0;

  // Add new auctions, update bids on existing regular auctions
  for (const auction of allRawAuctions) {
    const existing = allTracked.get(auction.uuid);
    if (!existing) {
      allTracked.set(auction.uuid, processNewAuction(auction, nameToId));
      addedCount++;
    } else if (!existing.bin && auction.highest_bid_amount > existing.highest_bid) {
      // Update highest bid on regular auctions
      existing.highest_bid = auction.highest_bid_amount;
      existing.price = auction.highest_bid_amount;
      updatedCount++;
    }
  }

  // Remove expired/sold auctions
  for (const auctionId of allTracked.keys()) {
    if (!newAuctionIds.has(auctionId)) {
      allTracked.delete(auctionId);
      removedCount++;
    }
  }

  // Rebuild derived views
  rebuildViews();

  // Build lowest BINs from BIN sub-map
  const lowestBins = buildLowestBins();

  // --- Publish alerts ---

  let alertsPublished = 0;
  for (const [baseItem, data] of lowestBins) {
    const previous = previousLowestBins.get(baseItem);
    if (previous && data.lowest.price < previous.lowest.price) {
      await publish('auction:alerts', {
        type: 'auction:new_lowest_bin',
        item_id: baseItem,
        item_name: data.lowest.item_name,
        price: data.lowest.price,
        auction_id: data.lowest.auction_id,
        timestamp: Date.now(),
      });
      alertsPublished++;
    }
  }

  for (const auction of endingSoon) {
    await publish('auction:ending', {
      type: 'auction:ending_soon',
      item_id: extractBaseItem(auction.item_name),
      item_name: auction.item_name,
      price: auction.bin ? auction.starting_bid : auction.highest_bid_amount,
      auction_id: auction.uuid,
      ends_at: auction.end,
      timestamp: Date.now(),
    });
  }

  // --- Cache results ---

  const cacheEntries = Array.from(lowestBins.entries()).map(([baseItem, data]) => ({
    id: baseItem, data,
  }));

  const skyblockIdEntries: Array<{ id: string; data: LowestBinData }> = [];
  let unmatchedCount = 0;
  for (const data of lowestBins.values()) {
    if (data.skyblock_id) {
      skyblockIdEntries.push({ id: data.skyblock_id, data });
    } else {
      unmatchedCount++;
    }
  }

  if (cacheEntries.length > 0) {
    await cacheSetBulk('hot', 'auction-lowest', cacheEntries, firstPage.lastUpdated);
    await cacheSetBulk('hot', 'auction-lowest-id', skyblockIdEntries, firstPage.lastUpdated);

    const allLowest = Object.fromEntries(lowestBins);
    await cacheSet('hot', 'auction-lowest-all', 'latest', allLowest, firstPage.lastUpdated);

    const allById: Record<string, LowestBinData> = {};
    for (const data of lowestBins.values()) {
      if (data.skyblock_id) allById[data.skyblock_id] = data;
    }
    await cacheSet('hot', 'auction-lowest-all-by-id', 'latest', allById, firstPage.lastUpdated);
  }

  if (unmatchedCount > 0) {
    log.debug({ unmatched_items: unmatchedCount }, 'Auction items without skyblock_id');
  }

  previousLowestBins = lowestBins;

  log.info({
    total_api: firstPage.totalAuctions,
    tracked: allTracked.size,
    bin: binAuctions.size,
    regular: regularAuctions.size,
    added: addedCount,
    removed: removedCount,
    updated: updatedCount,
    pages: firstPage.totalPages,
    priority_pages: priorityCount + 1,
    priority_fetch_ms: priorityDuration,
    pages_succeeded: pagesSucceeded,
    fetch_duration_ms: fetchDuration,
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
    { every: 1000 },
    { name: 'auction-scan' },
  );

  createWorker(QUEUE_NAME, processAuctionJob);
  queue.add('auction-scan-immediate', {}, { priority: 1 });
}
