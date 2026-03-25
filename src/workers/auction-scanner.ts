import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchAuctionsPage, fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheSetBulk } from '../services/cache-manager.js';
import { postgrestInsert } from '../services/postgrest-client.js';
import { publish } from '../services/event-bus.js';
import { createLogger } from '../utils/logger.js';
import type { HypixelAuction, HypixelAuctionsPageResponse, HypixelEndedAuctionsResponse } from '../types/hypixel.js';

const log = createLogger('auction-scanner');

const ENDING_SOON_WINDOW_MS = 120_000;   // 2 minutes
const PENDING_TIMEOUT_MS = 1_800_000;    // 30 minutes — generous timeout before marking expired

// --- Types ---

export interface TrackedAuction {
  auction_id: string;
  base_item: string;
  skyblock_id: string | null;
  item_name: string;
  price: number;
  starting_bid: number;
  highest_bid: number;
  seller_uuid: string;
  starts_at: number;
  ends_at: number;
  tier: string;
  category: string;
  bin: boolean;
}

interface PendingAuction {
  auction: TrackedAuction;
  removed_at: number; // When it disappeared from active endpoint
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

interface AuctionHistoryRow {
  auction_id: string;
  skyblock_id: string | null;
  base_item: string;
  item_name: string;
  seller_uuid: string;
  buyer_uuid: string | null;
  starting_bid: number;
  final_price: number;
  bin: boolean;
  tier: string | null;
  category: string | null;
  outcome: 'sold' | 'expired' | 'cancelled';
  started_at: string;
  ended_at: string;
}

// --- In-memory state ---

let knownItemNames: Set<string> = new Set();

// Active auctions
const allTracked = new Map<string, TrackedAuction>();
const binAuctions = new Map<string, TrackedAuction>();
const regularAuctions = new Map<string, TrackedAuction>();

// Auctions that disappeared — held until auctions_ended confirms or timeout
const pendingAuctions = new Map<string, PendingAuction>();

// Confirmed sold auction IDs (from auctions_ended endpoint)
const recentlySoldIds = new Set<string>();

// Previous lowest BINs for alerts
let previousLowestBins = new Map<string, LowestBinData>();

// Dependency status
let itemsAvailable = false;
let needsReprocess = false; // True when auctions were tracked without item resolution

// Last-modified headers
let activeLastModified: string | undefined;
let endedLastModified: string | undefined;

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
    starts_at: auction.start,
    ends_at: auction.end,
    tier: auction.tier,
    category: auction.category,
    bin: auction.bin,
  };
}

function rebuildViews(): void {
  binAuctions.clear();
  regularAuctions.clear();
  for (const [id, auction] of allTracked) {
    if (auction.bin) binAuctions.set(id, auction);
    else regularAuctions.set(id, auction);
  }
}

function buildLowestBins(): Map<string, LowestBinData> {
  const itemGroups = new Map<string, TrackedAuction[]>();
  for (const auction of binAuctions.values()) {
    const group = itemGroups.get(auction.base_item);
    if (group) group.push(auction);
    else itemGroups.set(auction.base_item, [auction]);
  }

  const lowestBins = new Map<string, LowestBinData>();
  for (const [baseItem, auctions] of itemGroups) {
    auctions.sort((a, b) => a.price - b.price);
    const listings: AuctionItemData[] = auctions.slice(0, 20).map((a) => ({
      item_name: a.item_name, price: a.price, auction_id: a.auction_id,
      seller_uuid: a.seller_uuid, ends_at: a.ends_at, tier: a.tier, category: a.category,
    }));
    lowestBins.set(baseItem, {
      skyblock_id: auctions[0]!.skyblock_id, base_item: baseItem,
      lowest: listings[0]!, listings, count: auctions.length,
    });
  }
  return lowestBins;
}

function toHistoryRow(auction: TrackedAuction, outcome: 'sold' | 'expired' | 'cancelled', buyerUuid: string | null, finalPrice: number): AuctionHistoryRow {
  return {
    auction_id: auction.auction_id,
    skyblock_id: auction.skyblock_id,
    base_item: auction.base_item,
    item_name: auction.item_name,
    seller_uuid: auction.seller_uuid,
    buyer_uuid: buyerUuid,
    starting_bid: auction.starting_bid,
    final_price: finalPrice,
    bin: auction.bin,
    tier: auction.tier,
    category: auction.category,
    outcome,
    started_at: new Date(auction.starts_at).toISOString(),
    ended_at: new Date().toISOString(),
  };
}

// --- Ended auctions processor (polls auctions_ended) ---

async function processEndedAuctions(): Promise<{ soldCount: number; expiredCount: number }> {
  const result = await fetchConditional<HypixelEndedAuctionsResponse>(
    { endpoint: '/v2/skyblock/auctions_ended' },
    endedLastModified,
  );

  if (!result.modified) return { soldCount: 0, expiredCount: 0 };

  const response = result.data!;
  endedLastModified = result.lastModified ?? endedLastModified;

  if (!response.success) return { soldCount: 0, expiredCount: 0 };

  // Cache raw ended auctions
  await cacheSet('hot', 'auctions-ended', 'latest', response.auctions, response.lastUpdated);

  // Build set of sold auction IDs
  recentlySoldIds.clear();
  for (const ended of response.auctions) {
    recentlySoldIds.add(ended.auction_id);
  }

  // Process pending auctions against sold list
  const historyRows: AuctionHistoryRow[] = [];
  let soldCount = 0;
  let expiredCount = 0;
  const now = Date.now();

  for (const [auctionId, pending] of pendingAuctions) {
    if (recentlySoldIds.has(auctionId)) {
      // Confirmed sold — find buyer/price from ended data
      const endedData = response.auctions.find((e) => e.auction_id === auctionId);
      const finalPrice = endedData?.price ?? pending.auction.price;
      const buyerUuid = endedData?.buyer ?? null;
      historyRows.push(toHistoryRow(pending.auction, 'sold', buyerUuid, finalPrice));

      // Publish sold event
      await publish('auction:sold', {
        type: 'auction:sold',
        auction_id: auctionId,
        skyblock_id: pending.auction.skyblock_id,
        base_item: pending.auction.base_item,
        item_name: pending.auction.item_name,
        seller_uuid: pending.auction.seller_uuid,
        buyer_uuid: buyerUuid,
        price: finalPrice,
        bin: pending.auction.bin,
        timestamp: Date.now(),
      });

      pendingAuctions.delete(auctionId);
      soldCount++;
    } else if (now - pending.removed_at > PENDING_TIMEOUT_MS) {
      // Timed out — mark as expired/cancelled
      historyRows.push(toHistoryRow(pending.auction, 'expired', null, 0));
      pendingAuctions.delete(auctionId);
      expiredCount++;
    }
    // Otherwise: still pending, wait for next ended update
  }

  // Store to Postgres
  if (historyRows.length > 0) {
    try {
      await postgrestInsert('auction_history', historyRows, 'auction_id');
    } catch (err) {
      log.error({ err }, 'Failed to insert auction history');
    }
  }

  // Cache recently sold for the API endpoint
  const recentSold = historyRows.filter((r) => r.outcome === 'sold');
  if (recentSold.length > 0) {
    await cacheSet('hot', 'auctions-recently-sold', 'latest', recentSold, response.lastUpdated);
  }

  return { soldCount, expiredCount };
}

// --- Active auctions processor ---

async function processActiveAuctions(_job: Job): Promise<void> {
  const startTime = Date.now();

  // Load item resolution data (optional — auctions still tracked without it)
  const itemNamesCache = await cacheGet<string[]>('warm', 'resources', 'item-known-names');
  const nameToIdCache = await cacheGet<Record<string, string>>('warm', 'resources', 'item-name-to-id');

  const wasAvailable = itemsAvailable;
  itemsAvailable = !!itemNamesCache;

  if (itemNamesCache) {
    knownItemNames = new Set(itemNamesCache.data);
  }
  const nameToId = nameToIdCache?.data ?? {};

  // If items just became available and we have unresolved auctions, reprocess them
  if (itemsAvailable && !wasAvailable && allTracked.size > 0) {
    needsReprocess = true;
    log.info({ tracked: allTracked.size }, 'Items cache now available — reprocessing tracked auctions');
  }

  if (needsReprocess && itemsAvailable) {
    for (const auction of allTracked.values()) {
      const newBase = extractBaseItem(auction.item_name);
      if (newBase !== auction.base_item || !auction.skyblock_id) {
        auction.base_item = newBase;
        auction.skyblock_id = nameToId[newBase] ?? null;
      }
    }
    needsReprocess = false;
  }

  // Conditional fetch on page 0
  const checkResult = await fetchConditional<HypixelAuctionsPageResponse>(
    { endpoint: '/v2/skyblock/auctions', params: { page: '0' } },
    activeLastModified,
  );

  if (!checkResult.modified) {
    // Even if active unchanged, still check ended
    const { soldCount, expiredCount } = await processEndedAuctions();
    if (soldCount > 0 || expiredCount > 0) {
      log.info(`Auctions | sold:${soldCount} expired:${expiredCount} pending:${pendingAuctions.size}`);
    }
    return;
  }

  const firstPage = checkResult.data!;
  activeLastModified = checkResult.lastModified ?? activeLastModified;

  if (!firstPage.success) {
    log.warn('Auction fetch returned success=false');
    return;
  }

  // Fetch ALL pages
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
  for (const p of priorityPages) { if (p?.success) { collectPage(p.auctions); pagesSucceeded++; } }

  if (remainingCount > 0) {
    const remainingPromises = Array.from(
      { length: remainingCount },
      (_, i) => fetchAuctionsPage(i + 1 + priorityCount).catch((err) => {
        log.warn({ page: i + 1 + priorityCount, err }, 'Failed to fetch auction page');
        return null;
      }),
    );
    const remainingPages = await Promise.all(remainingPromises);
    for (const p of remainingPages) { if (p?.success) { collectPage(p.auctions); pagesSucceeded++; } }
  }

  const fetchDuration = Date.now() - fetchStart;

  // --- Diff against tracked state ---

  const newAuctionIds = new Set(allRawAuctions.map((a) => a.uuid));
  let addedCount = 0;
  let removedCount = 0;
  let updatedCount = 0;

  // Add new / update existing
  const newListings: TrackedAuction[] = [];
  for (const auction of allRawAuctions) {
    const existing = allTracked.get(auction.uuid);
    if (!existing) {
      const tracked = processNewAuction(auction, nameToId);
      allTracked.set(auction.uuid, tracked);
      newListings.push(tracked);
      addedCount++;
    } else if (!existing.bin && auction.highest_bid_amount > existing.highest_bid) {
      existing.highest_bid = auction.highest_bid_amount;
      existing.price = auction.highest_bid_amount;
      updatedCount++;
    }
  }

  // Move removed auctions to pending (don't discard immediately)
  for (const [auctionId, auction] of allTracked) {
    if (!newAuctionIds.has(auctionId)) {
      pendingAuctions.set(auctionId, { auction, removed_at: Date.now() });
      allTracked.delete(auctionId);
      removedCount++;
    }
  }

  // --- Process ended auctions to resolve pending ---
  const { soldCount, expiredCount } = await processEndedAuctions();

  // Rebuild views + lowest BINs
  rebuildViews();
  const lowestBins = buildLowestBins();

  // --- Publish events ---
  let alertsPublished = 0;

  // New listing events
  for (const listing of newListings) {
    await publish('auction:new-listing', {
      type: 'auction:new-listing',
      auction_id: listing.auction_id,
      skyblock_id: listing.skyblock_id,
      base_item: listing.base_item,
      item_name: listing.item_name,
      price: listing.price,
      seller_uuid: listing.seller_uuid,
      ends_at: listing.ends_at,
      bin: listing.bin,
      tier: listing.tier,
      timestamp: Date.now(),
    });
  }

  // Lowest BIN change events (both increases and decreases)
  for (const [baseItem, data] of lowestBins) {
    const previous = previousLowestBins.get(baseItem);
    if (previous && data.lowest.price !== previous.lowest.price) {
      const changePct = previous.lowest.price > 0
        ? Math.round(((data.lowest.price - previous.lowest.price) / previous.lowest.price) * 10000) / 100
        : 0;
      await publish('auction:lowest-bin-change', {
        type: 'auction:lowest-bin-change',
        skyblock_id: data.skyblock_id,
        base_item: baseItem,
        old_price: previous.lowest.price,
        new_price: data.lowest.price,
        auction_id: data.lowest.auction_id,
        item_name: data.lowest.item_name,
        change_pct: changePct,
        timestamp: Date.now(),
      });
      alertsPublished++;

      // Also publish on the legacy channel for backwards compat
      if (data.lowest.price < previous.lowest.price) {
        await publish('auction:alerts', {
          type: 'auction:new_lowest_bin',
          item_id: baseItem,
          item_name: data.lowest.item_name,
          price: data.lowest.price,
          auction_id: data.lowest.auction_id,
          timestamp: Date.now(),
        });
      }
    }
  }

  // Ending soon events
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

  // --- Cache ---
  const cacheEntries = Array.from(lowestBins.entries()).map(([baseItem, data]) => ({ id: baseItem, data }));
  const skyblockIdEntries: Array<{ id: string; data: LowestBinData }> = [];
  let unmatchedCount = 0;
  for (const data of lowestBins.values()) {
    if (data.skyblock_id) skyblockIdEntries.push({ id: data.skyblock_id, data });
    else unmatchedCount++;
  }

  if (cacheEntries.length > 0) {
    await cacheSetBulk('hot', 'auction-lowest', cacheEntries, firstPage.lastUpdated);
    await cacheSetBulk('hot', 'auction-lowest-id', skyblockIdEntries, firstPage.lastUpdated);
    await cacheSet('hot', 'auction-lowest-all', 'latest', Object.fromEntries(lowestBins), firstPage.lastUpdated);
    const allById: Record<string, LowestBinData> = {};
    for (const data of lowestBins.values()) { if (data.skyblock_id) allById[data.skyblock_id] = data; }
    await cacheSet('hot', 'auction-lowest-all-by-id', 'latest', allById, firstPage.lastUpdated);
  }

  // Cache raw auction pages for rebuild capability
  await cacheSet('hot', 'auctions-raw-pages', 'latest', allRawAuctions, firstPage.lastUpdated);

  // Cache full tracked state (active + pending) so API can serve it and it's recoverable
  const trackedSnapshot = Object.fromEntries(allTracked);
  await cacheSet('hot', 'auctions-active', 'latest', trackedSnapshot, firstPage.lastUpdated);

  const pendingSnapshot = Object.fromEntries(
    Array.from(pendingAuctions.entries()).map(([id, p]) => [id, p.auction]),
  );
  await cacheSet('hot', 'auctions-pending', 'latest', pendingSnapshot, firstPage.lastUpdated);

  if (unmatchedCount > 0) log.debug({ unmatched_items: unmatchedCount }, 'Auction items without skyblock_id');

  previousLowestBins = lowestBins;

  const durationMs = Date.now() - startTime;

  // Compact info line — just the changes that matter
  const statusFlags = itemsAvailable ? '' : ' [NO ITEM RESOLUTION]';
  log.info(
    `Auctions | +${addedCount} -${removedCount} ~${updatedCount} | sold:${soldCount} expired:${expiredCount} | tracked:${allTracked.size} (bin:${binAuctions.size} reg:${regularAuctions.size}) pending:${pendingAuctions.size} | items:${lowestBins.size} alerts:${alertsPublished} | ${durationMs}ms${statusFlags}`,
  );

  // Full details behind debug
  log.debug({
    total_api: firstPage.totalAuctions,
    tracked: allTracked.size,
    bin: binAuctions.size,
    regular: regularAuctions.size,
    pending: pendingAuctions.size,
    added: addedCount,
    removed: removedCount,
    updated: updatedCount,
    sold: soldCount,
    expired: expiredCount,
    pages: firstPage.totalPages,
    priority_fetch_ms: priorityDuration,
    pages_succeeded: pagesSucceeded,
    fetch_duration_ms: fetchDuration,
    unique_items: lowestBins.size,
    ending_soon: endingSoon.length,
    alerts_published: alertsPublished,
    duration_ms: durationMs,
  }, 'Auction scan details');
}

// --- Startup ---

export function startAuctionScanner(): void {
  const queue = getQueue('auction-scanner');

  queue.upsertJobScheduler(
    'auction-scan',
    { every: 1000 },
    { name: 'auction-scan' },
  );

  createWorker('auction-scanner', processActiveAuctions);
  queue.add('auction-scan-immediate', {}, { priority: 1 });
}
