import type { Job } from 'bullmq';
import { getQueue, createWorker } from '../utils/queue.js';
import { fetchAuctionsPage, fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheSetBulk } from '../services/cache-manager.js';
import { postgrestInsert, postgrestSelect } from '../services/postgrest-client.js';
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
  extra: string;
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
  item_bytes: string | null;
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
let needsReprocess = false;

// Last-modified headers
let activeLastModified: string | undefined;
let endedLastModified: string | undefined;

const FAST_PAGES = 5; // Pages 0-4 fetched in the fast pass

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
    extra: auction.extra,
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

function toHistoryRow(auction: TrackedAuction, outcome: 'sold' | 'expired' | 'cancelled', buyerUuid: string | null, finalPrice: number, itemBytes: string | null): AuctionHistoryRow {
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
    item_bytes: itemBytes,

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

  // Batch-fetch item_bytes for pending auctions from Postgres
  const pendingIds = Array.from(pendingAuctions.keys());
  const itemBytesMap = new Map<string, string>();
  if (pendingIds.length > 0) {
    try {
      const rows = await postgrestSelect<{ auction_id: string; item_bytes: string }>({
        table: 'auction_item_data',
        query: { auction_id: `in.(${pendingIds.join(',')})` },
        select: 'auction_id,item_bytes',
      });
      for (const row of rows) {
        itemBytesMap.set(row.auction_id, row.item_bytes);
      }
    } catch {
      // auction_item_data may not exist yet
    }
  }

  // Process pending auctions against sold list
  const historyRows: AuctionHistoryRow[] = [];
  let soldCount = 0;
  let expiredCount = 0;
  const now = Date.now();

  for (const [auctionId, pending] of pendingAuctions) {
    if (recentlySoldIds.has(auctionId)) {
      const endedData = response.auctions.find((e) => e.auction_id === auctionId);
      const finalPrice = endedData?.price ?? pending.auction.price;
      const buyerUuid = endedData?.buyer ?? null;
      const itemBytes = itemBytesMap.get(auctionId) ?? null;
      historyRows.push(toHistoryRow(pending.auction, 'sold', buyerUuid, finalPrice, itemBytes));

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
      const itemBytes = itemBytesMap.get(auctionId) ?? null;
      historyRows.push(toHistoryRow(pending.auction, 'expired', null, 0, itemBytes));
      pendingAuctions.delete(auctionId);
      expiredCount++;
    }
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

  // --- Helper: add new auctions and update bids (no removals) ---
  function addAndUpdate(rawAuctions: HypixelAuction[]): {
    added: number; updated: number;
    newListings: TrackedAuction[];
    newItemBytes: Array<{ auction_id: string; item_bytes: string }>;
  } {
    let added = 0;
    let updated = 0;
    const newListings: TrackedAuction[] = [];
    const newItemBytes: Array<{ auction_id: string; item_bytes: string }> = [];

    for (const auction of rawAuctions) {
      const existing = allTracked.get(auction.uuid);
      if (!existing) {
        const tracked = processNewAuction(auction, nameToId);
        allTracked.set(auction.uuid, tracked);
        newListings.push(tracked);
        if (auction.item_bytes) {
          newItemBytes.push({ auction_id: auction.uuid, item_bytes: auction.item_bytes });
        }
        added++;
      } else if (!existing.bin && auction.highest_bid_amount > existing.highest_bid) {
        existing.highest_bid = auction.highest_bid_amount;
        existing.price = auction.highest_bid_amount;
        updated++;
      }
    }

    return { added, updated, newListings, newItemBytes };
  }

  // --- Helper: expire past-end auctions and remove missing IDs ---
  function removeStale(seenIds?: Set<string>): number {
    let removed = 0;
    const expireNow = Date.now();
    for (const [auctionId, auction] of allTracked) {
      const expired = auction.ends_at < expireNow;
      const missing = seenIds ? !seenIds.has(auctionId) : false;
      if (expired || missing) {
        pendingAuctions.set(auctionId, { auction, removed_at: expireNow });
        allTracked.delete(auctionId);
        removed++;
      }
    }
    return removed;
  }

  async function storeItemBytes(items: Array<{ auction_id: string; item_bytes: string }>): Promise<void> {
    if (items.length > 0) {
      try {
        await postgrestInsert('auction_item_data', items, 'auction_id');
      } catch (err) {
        log.error({ err }, 'Failed to insert auction item_bytes');
      }
    }
  }

  // ============ FAST PASS: pages 0-4 ============

  collectPage(firstPage.auctions);

  const fastCount = Math.min(FAST_PAGES - 1, firstPage.totalPages - 1);
  const fastStart = Date.now();

  if (fastCount > 0) {
    const fastPromises = Array.from(
      { length: fastCount },
      (_, i) => fetchAuctionsPage(i + 1).catch((err) => {
        log.warn({ page: i + 1, err }, 'Failed to fetch auction page');
        return null;
      }),
    );
    const fastPages = await Promise.all(fastPromises);
    for (const p of fastPages) { if (p?.success) collectPage(p.auctions); }
  }

  const fastDuration = Date.now() - fastStart;

  // Add new auctions from fast pages
  const fast = addAndUpdate(allRawAuctions);
  await storeItemBytes(fast.newItemBytes);

  // Expire past-end auctions + process ended
  const fastRemoved = removeStale();
  const { soldCount: fastSold, expiredCount: fastExpired } = await processEndedAuctions();

  // Rebuild and publish once for fast pass
  rebuildViews();
  const fastLowestBins = buildLowestBins();

  // --- Helper: publish events, cache, and log for a pass ---
  async function publishAndCache(
    lowestBins: Map<string, LowestBinData>,
    listings: TrackedAuction[],
    passName: string,
    added: number, removed: number, updated: number,
    sold: number, expired: number, fetchMs: number,
  ): Promise<number> {
    let alerts = 0;

    // New listing events
    for (const listing of listings) {
      await publish('auction:new-listing', {
        type: 'auction:new-listing', auction_id: listing.auction_id,
        skyblock_id: listing.skyblock_id, base_item: listing.base_item,
        item_name: listing.item_name, price: listing.price,
        seller_uuid: listing.seller_uuid, ends_at: listing.ends_at,
        bin: listing.bin, tier: listing.tier, timestamp: Date.now(),
      });
    }

    // Lowest BIN change events
    for (const [baseItem, data] of lowestBins) {
      const previous = previousLowestBins.get(baseItem);
      if (previous && data.lowest.price !== previous.lowest.price) {
        const changePct = previous.lowest.price > 0
          ? Math.round(((data.lowest.price - previous.lowest.price) / previous.lowest.price) * 10000) / 100 : 0;
        await publish('auction:lowest-bin-change', {
          type: 'auction:lowest-bin-change', skyblock_id: data.skyblock_id,
          base_item: baseItem, old_price: previous.lowest.price, new_price: data.lowest.price,
          auction_id: data.lowest.auction_id, item_name: data.lowest.item_name,
          change_pct: changePct, timestamp: Date.now(),
        });
        alerts++;
        if (data.lowest.price < previous.lowest.price) {
          await publish('auction:alerts', {
            type: 'auction:new_lowest_bin', item_id: baseItem,
            item_name: data.lowest.item_name, price: data.lowest.price,
            auction_id: data.lowest.auction_id, timestamp: Date.now(),
          });
        }
      }
    }

    // Ending soon events
    for (const auction of endingSoon) {
      await publish('auction:ending', {
        type: 'auction:ending_soon', item_id: extractBaseItem(auction.item_name),
        item_name: auction.item_name,
        price: auction.bin ? auction.starting_bid : auction.highest_bid_amount,
        auction_id: auction.uuid, ends_at: auction.end, timestamp: Date.now(),
      });
    }

    // Cache lowest BINs
    const cacheEntries = Array.from(lowestBins.entries()).map(([b, d]) => ({ id: b, data: d }));
    const skyblockIdEntries: Array<{ id: string; data: LowestBinData }> = [];
    for (const data of lowestBins.values()) {
      if (data.skyblock_id) skyblockIdEntries.push({ id: data.skyblock_id, data });
    }
    if (cacheEntries.length > 0) {
      await cacheSetBulk('hot', 'auction-lowest', cacheEntries, firstPage.lastUpdated);
      await cacheSetBulk('hot', 'auction-lowest-id', skyblockIdEntries, firstPage.lastUpdated);
      await cacheSet('hot', 'auction-lowest-all', 'latest', Object.fromEntries(lowestBins), firstPage.lastUpdated);
      const allById: Record<string, LowestBinData> = {};
      for (const data of lowestBins.values()) { if (data.skyblock_id) allById[data.skyblock_id] = data; }
      await cacheSet('hot', 'auction-lowest-all-by-id', 'latest', allById, firstPage.lastUpdated);
    }

    // Cache tracked state
    await cacheSet('hot', 'auctions-active', 'latest', Object.fromEntries(allTracked), firstPage.lastUpdated);
    await cacheSet('hot', 'auctions-pending', 'latest',
      Object.fromEntries(Array.from(pendingAuctions.entries()).map(([id, p]) => [id, p.auction])),
      firstPage.lastUpdated);

    previousLowestBins = lowestBins;

    const passMs = Date.now() - startTime;
    const flags = itemsAvailable ? '' : ' [NO ITEM RESOLUTION]';
    log.info(
      `Auctions ${passName} | +${added} -${removed} ~${updated} | sold:${sold} expired:${expired} | tracked:${allTracked.size} (bin:${binAuctions.size} reg:${regularAuctions.size}) pending:${pendingAuctions.size} | items:${lowestBins.size} alerts:${alerts} | fetch:${fetchMs}ms total:${passMs}ms${flags}`,
    );

    return alerts;
  }

  // Publish + cache fast pass results
  await publishAndCache(fastLowestBins, fast.newListings, 'FAST',
    fast.added, fastRemoved, fast.updated, fastSold, fastExpired, fastDuration);

  // ============ REMAINING PASS: pages 5+ ============

  const remainingCount = firstPage.totalPages - 1 - fastCount;
  if (remainingCount > 0) {
    const remainingRaw: HypixelAuction[] = [];
    const remainStart = Date.now();

    const remainingPromises = Array.from(
      { length: remainingCount },
      (_, i) => fetchAuctionsPage(i + 1 + fastCount).catch((err) => {
        log.warn({ page: i + 1 + fastCount, err }, 'Failed to fetch auction page');
        return null;
      }),
    );
    const remainingPages = await Promise.all(remainingPromises);
    for (const p of remainingPages) {
      if (p?.success) {
        for (const a of p.auctions) remainingRaw.push(a);
      }
    }

    const remainDuration = Date.now() - remainStart;

    // Add new auctions from remaining pages
    const remain = addAndUpdate(remainingRaw);
    await storeItemBytes(remain.newItemBytes);

    // Full removal: expire past-end + remove anything not seen across all pages
    const allSeenIds = new Set([
      ...allRawAuctions.map((a) => a.uuid),
      ...remainingRaw.map((a) => a.uuid),
    ]);
    const fullRemoved = removeStale(allSeenIds);

    const { soldCount: remainSold, expiredCount: remainExpired } = await processEndedAuctions();

    rebuildViews();
    const remainLowestBins = buildLowestBins();

    await publishAndCache(remainLowestBins, remain.newListings, 'FULL',
      remain.added, fullRemoved, remain.updated,
      remainSold, remainExpired, remainDuration);
  }
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
