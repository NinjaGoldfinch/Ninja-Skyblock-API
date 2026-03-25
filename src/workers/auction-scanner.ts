import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchAuctionsPage, fetchConditional } from '../services/hypixel-client.js';
import { cacheSetBulk } from '../services/cache-manager.js';
import { publish } from '../services/event-bus.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelAuction, HypixelAuctionsPageResponse } from '../types/hypixel.js';

const log = createLogger('auction-scanner');
const QUEUE_NAME = 'auction-scanner';

const ENDING_SOON_WINDOW_MS = 120_000; // 2 minutes

// In-memory state for conditional polling
let lastModifiedHeader: string | undefined;

// Known reforge prefixes to strip when extracting base item name
const REFORGE_PREFIXES = [
  'Withered', 'Fabled', 'Heroic', 'Suspicious', 'Ancient', 'Titanic',
  'Wise', 'Fierce', 'Legendary', 'Mythic', 'Epic', 'Heavy', 'Light',
  'Lucky', 'Rapid', 'Fair', 'Sharp', 'Forceful', 'Strong', 'Hurtful',
  'Keen', 'Spiritual', 'Odd', 'Rich', 'Gentle', 'Bizarre', 'Neat',
  'Fast', 'Fine', 'Grand', 'Hasty', 'Clean', 'Deadly', 'Unreal',
  'Awkward', 'Spicy', 'Treacherous', 'Demonic', 'Salty', 'Silky',
  'Bloody', 'Shaded', 'Sweet', 'Warped', 'Loving', 'Itchy',
  'Ominous', 'Pleasant', 'Zealous', 'Godly', 'Superior',
  'Renowned', 'Submerged', 'Perfect', 'Auspicious', 'Moil',
  'Toil', 'Blooming', 'Stellar', 'Jaded', 'Sighted',
  'Shiny',
];

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
  base_item: string;
  lowest: AuctionItemData;
  listings: AuctionItemData[];
  count: number;
}

/**
 * Extract a base item name by stripping reforges, stars, and formatting.
 * "Withered Hyperion ✪✪✪✪✪➎" -> "Hyperion"
 * "[Lvl 100] Baby Yeti" -> "Baby Yeti" (pet)
 * "⚚ Spiritual Bonemerang ✪✪✪✪✪" -> "Bonemerang"
 */
function extractBaseItem(itemName: string): string {
  let name = itemName;

  // Strip leading special characters (⚚, etc.)
  name = name.replace(/^[^\w\[]+/, '');

  // Strip pet level prefix "[Lvl N] "
  name = name.replace(/^\[Lvl \d+\]\s*/, '');

  // Strip stars and upgrade symbols at end
  name = name.replace(/[\s✪✦➊➋➌➍➎⚚]+$/g, '').trim();

  // Strip "Shiny " prefix
  if (name.startsWith('Shiny ')) {
    name = name.slice(6);
  }

  // Strip reforge prefix (first word if it's a known reforge)
  const firstSpace = name.indexOf(' ');
  if (firstSpace > 0) {
    const firstWord = name.slice(0, firstSpace);
    if (REFORGE_PREFIXES.includes(firstWord)) {
      name = name.slice(firstSpace + 1);
    }
  }

  return name.trim();
}

// In-memory previous lowest BINs for change detection
let previousLowestBins = new Map<string, LowestBinData>();

async function processAuctionJob(_job: Job): Promise<void> {
  const startTime = Date.now();

  // Conditional fetch on page 0 — check if data has changed
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

  // Collect all BIN auctions and ending-soon across all pages
  const allBinAuctions: HypixelAuction[] = [];
  const endingSoon: HypixelAuction[] = [];
  const now = Date.now();

  function processPage(auctions: HypixelAuction[]): void {
    for (const auction of auctions) {
      if (auction.bin) {
        allBinAuctions.push(auction);
      }
      if (auction.end - now <= ENDING_SOON_WINDOW_MS && auction.end > now) {
        endingSoon.push(auction);
      }
    }
  }

  // Process page 0 (already fetched)
  processPage(firstPage.auctions);

  const totalRemaining = firstPage.totalPages - 1;
  const PRIORITY_PAGES = 15; // First N pages have the most actively traded items
  const priorityCount = Math.min(PRIORITY_PAGES, totalRemaining);
  const remainingCount = totalRemaining - priorityCount;
  const fetchStart = Date.now();
  let pagesSucceeded = 1; // page 0 already succeeded

  // Fetch priority pages first (pages 1-15)
  const priorityPromises = Array.from(
    { length: priorityCount },
    (_, i) => fetchAuctionsPage(i + 1).catch((err) => {
      log.warn({ page: i + 1, err }, 'Failed to fetch auction page');
      return null;
    }),
  );
  const priorityPages = await Promise.all(priorityPromises);
  for (const pageData of priorityPages) {
    if (pageData?.success) {
      processPage(pageData.auctions);
      pagesSucceeded++;
    }
  }

  // Then fetch remaining pages (16+)
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
      if (pageData?.success) {
        processPage(pageData.auctions);
        pagesSucceeded++;
      }
    }
  }

  const fetchDuration = Date.now() - fetchStart;

  // Group BIN auctions by base item name, sorted by price
  const itemGroups = new Map<string, AuctionItemData[]>();
  for (const auction of allBinAuctions) {
    const baseItem = extractBaseItem(auction.item_name);
    const entry: AuctionItemData = {
      item_name: auction.item_name,
      price: auction.starting_bid,
      auction_id: auction.uuid,
      seller_uuid: auction.auctioneer,
      ends_at: auction.end,
      tier: auction.tier,
      category: auction.category,
    };

    const group = itemGroups.get(baseItem);
    if (group) {
      group.push(entry);
    } else {
      itemGroups.set(baseItem, [entry]);
    }
  }

  // Build lowest BIN data per base item
  const lowestBins = new Map<string, LowestBinData>();
  for (const [baseItem, listings] of itemGroups) {
    listings.sort((a, b) => a.price - b.price);
    const lowest = listings[0]!;
    lowestBins.set(baseItem, {
      base_item: baseItem,
      lowest,
      listings: listings.slice(0, 20), // Top 20 cheapest
      count: listings.length,
    });
  }

  // Publish alerts for new lowest BINs
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

  // Publish ending soon events
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

  // Cache lowest BINs keyed by base item name
  const cacheEntries = Array.from(lowestBins.entries()).map(([baseItem, data]) => ({
    id: baseItem,
    data,
  }));
  if (cacheEntries.length > 0) {
    await cacheSetBulk('hot', 'auction-lowest', cacheEntries, firstPage.lastUpdated);
  }

  previousLowestBins = lowestBins;

  log.info({
    total_auctions: firstPage.totalAuctions,
    pages: firstPage.totalPages,
    priority_pages: priorityCount + 1, // +1 for page 0
    pages_succeeded: pagesSucceeded,
    fetch_duration_ms: fetchDuration,
    bin_auctions: allBinAuctions.length,
    unique_items: lowestBins.size,
    ending_soon: endingSoon.length,
    alerts_published: alertsPublished,
    duration_ms: Date.now() - startTime,
  }, 'Auction scan complete');
}

export function startAuctionScanner(): void {
  const queue = getQueue(QUEUE_NAME);

  // Poll every 1s — conditional fetch skips processing when data hasn't changed
  queue.upsertJobScheduler(
    'auction-scan',
    { every: 1000 },
    { name: 'auction-scan' },
  );

  createWorker(QUEUE_NAME, processAuctionJob);

  // Fetch immediately on startup
  queue.add('auction-scan-immediate', {}, { priority: 1 });
}
