import { fetchAuctionsPage, fetchConditional } from '../services/hypixel-client.js';
import { cacheGet, cacheSet, cacheSetPipeline } from '../services/cache-manager.js';
import type { CachePipelineEntry } from '../services/cache-manager.js';
import { postgrestInsert, postgrestSelect } from '../services/postgrest-client.js';
import { publishBatch } from '../services/event-bus.js';
import type { EventChannel, EventPayload } from '../services/event-bus.js';
import { createLogger } from '../utils/logger.js';
import { stringifyAsync } from '../utils/json-worker.js';
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
let lastItemNamesCacheAge: number | null = null;

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
const ENDING_SOON_CHECK_INTERVAL_MS = 15_000; // 15s independent check

// Track which auctions already had ending-soon alerts sent
const notifiedEndingSoon = new Set<string>();

// --- Helpers ---

function stripFormatting(itemName: string): string {
  let name = itemName;
  name = name.replace(/^[^\w[]+/, '');
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

function addToViews(id: string, auction: TrackedAuction): void {
  if (auction.bin) binAuctions.set(id, auction);
  else regularAuctions.set(id, auction);
}

function removeFromViews(id: string, auction: TrackedAuction): void {
  if (auction.bin) binAuctions.delete(id);
  else regularAuctions.delete(id);
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

async function processEndedAuctions(): Promise<{ soldCount: number; expiredCount: number; endpointTotal: number }> {
  const result = await fetchConditional<HypixelEndedAuctionsResponse>(
    { endpoint: '/v2/skyblock/auctions_ended', noApiKey: true },
    endedLastModified,
  );

  if (!result.modified) return { soldCount: 0, expiredCount: 0, endpointTotal: 0 };

  const response = result.data!;
  endedLastModified = result.lastModified ?? endedLastModified;

  if (!response.success) return { soldCount: 0, expiredCount: 0, endpointTotal: 0 };

  // Cache raw ended auctions
  await cacheSet('hot', 'auctions-ended', 'latest', response.auctions, response.lastUpdated);

  // Build map of sold auction IDs → ended data for O(1) lookups
  recentlySoldIds.clear();
  const endedMap = new Map<string, (typeof response.auctions)[number]>();
  for (const ended of response.auctions) {
    recentlySoldIds.add(ended.auction_id);
    endedMap.set(ended.auction_id, ended);
  }

  // We'll fetch item_bytes per-auction when confirmed sold/expired
  const itemBytesMap = new Map<string, string>();

  // Move auctions that appear in the ended list directly from allTracked → pending
  // (they may not have been removed by removeStale yet if active data hasn't refreshed)
  for (const ended of response.auctions) {
    const tracked = allTracked.get(ended.auction_id);
    if (tracked && !pendingAuctions.has(ended.auction_id)) {
      pendingAuctions.set(ended.auction_id, { auction: tracked, removed_at: Date.now() });
      allTracked.delete(ended.auction_id);
      removeFromViews(ended.auction_id, tracked);
    }
  }

  // Collect auction IDs that are resolving this cycle
  const resolvingIds: string[] = [];
  const now = Date.now();

  for (const [auctionId, pending] of pendingAuctions) {
    if (recentlySoldIds.has(auctionId) || now - pending.removed_at > PENDING_TIMEOUT_MS) {
      resolvingIds.push(auctionId);
    }
  }

  // Batch-fetch item_bytes only for resolving auctions
  if (resolvingIds.length > 0) {
    try {
      const rows = await postgrestSelect<{ auction_id: string; item_bytes: string }>({
        table: 'auction_item_data',
        query: { auction_id: `in.(${resolvingIds.join(',')})` },
        select: 'auction_id,item_bytes',
      });
      for (const row of rows) {
        itemBytesMap.set(row.auction_id, row.item_bytes);
      }
    } catch (err) {
      log.warn({ err, count: resolvingIds.length }, 'Failed to fetch item_bytes for resolving auctions');
    }
  }

  // Process pending auctions against sold list
  const historyRows: AuctionHistoryRow[] = [];
  const soldEvents: Array<{ channel: EventChannel; event: EventPayload }> = [];
  let soldCount = 0;
  let expiredCount = 0;
  const ts = Date.now();

  for (const [auctionId, pending] of pendingAuctions) {
    if (recentlySoldIds.has(auctionId)) {
      const endedData = endedMap.get(auctionId);
      const finalPrice = endedData?.price ?? pending.auction.price;
      const buyerUuid = endedData?.buyer ?? null;
      const itemBytes = itemBytesMap.get(auctionId) ?? null;
      historyRows.push(toHistoryRow(pending.auction, 'sold', buyerUuid, finalPrice, itemBytes));

      soldEvents.push({ channel: 'auction:sold', event: {
        type: 'auction:sold',
        auction_id: auctionId,
        skyblock_id: pending.auction.skyblock_id,
        base_item: pending.auction.base_item,
        item_name: pending.auction.item_name,
        seller_uuid: pending.auction.seller_uuid,
        buyer_uuid: buyerUuid,
        price: finalPrice,
        bin: pending.auction.bin,
        timestamp: ts,
      }});

      pendingAuctions.delete(auctionId);
      soldCount++;
    } else if (now - pending.removed_at > PENDING_TIMEOUT_MS) {
      const itemBytes = itemBytesMap.get(auctionId) ?? null;
      historyRows.push(toHistoryRow(pending.auction, 'expired', null, 0, itemBytes));
      pendingAuctions.delete(auctionId);
      expiredCount++;
    }
  }

  // Fire Postgres insert, cache write, and event publishes concurrently
  const recentSold = historyRows.filter((r) => r.outcome === 'sold');
  await Promise.all([
    historyRows.length > 0
      ? postgrestInsert('auction_history', historyRows, 'auction_id').catch((err) => log.error({ err }, 'Failed to insert auction history'))
      : undefined,
    recentSold.length > 0
      ? cacheSet('hot', 'auctions-recently-sold', 'latest', recentSold, response.lastUpdated)
      : undefined,
    soldEvents.length > 0
      ? publishBatch(soldEvents)
      : undefined,
  ]);

  return { soldCount, expiredCount, endpointTotal: response.auctions.length };
}

// --- Active auctions processor ---

async function processActiveAuctions(): Promise<void> {
  const startTime = Date.now();

  // Load item resolution data (optional — auctions still tracked without it)
  // On startup, items worker may not have written yet — retry once after a short delay
  let itemNamesCache = await cacheGet<string[]>('warm', 'resources', 'item-known-names');
  let nameToIdCache = await cacheGet<Record<string, string>>('warm', 'resources', 'item-name-to-id');

  if (!itemNamesCache && !itemsAvailable) {
    await new Promise((r) => setTimeout(r, 3000));
    itemNamesCache = await cacheGet<string[]>('warm', 'resources', 'item-known-names');
    nameToIdCache = await cacheGet<Record<string, string>>('warm', 'resources', 'item-name-to-id');
  }

  const wasAvailable = itemsAvailable;
  itemsAvailable = !!itemNamesCache;

  if (itemNamesCache) {
    // Only rebuild Set if the cache entry is newer than what we already loaded
    if (itemNamesCache.cache_age_seconds !== lastItemNamesCacheAge) {
      knownItemNames = new Set(itemNamesCache.data);
      lastItemNamesCacheAge = itemNamesCache.cache_age_seconds;
    }
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
    { endpoint: '/v2/skyblock/auctions', params: { page: '0' }, noApiKey: true },
    activeLastModified,
  );

  if (!checkResult.modified) {
    return;
  }

  const firstPage = checkResult.data!;
  activeLastModified = checkResult.lastModified ?? activeLastModified;

  if (!firstPage.success) {
    log.warn('Auction fetch returned success=false');
    return;
  }

  const allRawAuctions: HypixelAuction[] = [];
  const seenIds = new Set<string>();

  function collectPage(auctions: HypixelAuction[]): void {
    for (const auction of auctions) {
      allRawAuctions.push(auction);
      seenIds.add(auction.uuid);
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
        addToViews(auction.uuid, tracked);
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
        removeFromViews(auctionId, auction);
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

  // ============ FETCH ALL PAGES — fire 1-N at once, split into fast/remain ============

  collectPage(firstPage.auctions);

  const totalRemaining = firstPage.totalPages - 1;
  const fastStart = Date.now();

  // Fire ALL page requests at once — FULL pages start fetching while FAST processes
  const allPagePromises = totalRemaining > 0
    ? Array.from(
        { length: totalRemaining },
        (_, i) => fetchAuctionsPage(i + 1).catch((err) => {
          log.warn({ page: i + 1, err }, 'Failed to fetch auction page');
          return null;
        }),
      )
    : [];

  const fastPromises = allPagePromises.slice(0, FAST_PAGES - 1);
  const remainPromises = allPagePromises.slice(FAST_PAGES - 1);

  // ============ FAST PASS: await pages 1-4 ============

  const fastPages = await Promise.all(fastPromises);
  for (const p of fastPages) { if (p?.success) collectPage(p.auctions); }

  const fastDuration = Date.now() - fastStart;

  // Add new auctions from fast pages
  const fast = addAndUpdate(allRawAuctions);

  // Expire past-end auctions + store item_bytes
  const fastRemoved = removeStale();
  await storeItemBytes(fast.newItemBytes);

  // Only rebuild lowest BINs if BIN auctions were added or removed
  const fastHasBinChanges = fast.newListings.some((l) => l.bin) || fastRemoved > 0;
  const fastLowestBins = fastHasBinChanges ? buildLowestBins() : previousLowestBins;

  // --- Helper: publish events, cache, and log for a pass ---
  async function publishAndCache(
    lowestBins: Map<string, LowestBinData>,
    listings: TrackedAuction[],
    passName: string,
    added: number, removed: number, updated: number,
    fetchMs: number, fullPass: boolean,
  ): Promise<number> {
    let alerts = 0;
    const ts = Date.now();

    // --- Collect all events into a batch ---
    const eventBatch: Array<{ channel: EventChannel; event: EventPayload }> = [];

    for (const listing of listings) {
      eventBatch.push({ channel: 'auction:new-listing', event: {
        type: 'auction:new-listing', auction_id: listing.auction_id,
        skyblock_id: listing.skyblock_id, base_item: listing.base_item,
        item_name: listing.item_name, price: listing.price,
        seller_uuid: listing.seller_uuid, ends_at: listing.ends_at,
        bin: listing.bin, tier: listing.tier, timestamp: ts,
      }});
    }

    for (const [baseItem, data] of lowestBins) {
      const previous = previousLowestBins.get(baseItem);
      if (previous && data.lowest.price !== previous.lowest.price) {
        const changePct = previous.lowest.price > 0
          ? Math.round(((data.lowest.price - previous.lowest.price) / previous.lowest.price) * 10000) / 100 : 0;
        eventBatch.push({ channel: 'auction:lowest-bin-change', event: {
          type: 'auction:lowest-bin-change', skyblock_id: data.skyblock_id,
          base_item: baseItem, old_price: previous.lowest.price, new_price: data.lowest.price,
          auction_id: data.lowest.auction_id, item_name: data.lowest.item_name,
          change_pct: changePct, timestamp: ts,
        }});
        alerts++;
        if (data.lowest.price < previous.lowest.price) {
          eventBatch.push({ channel: 'auction:alerts', event: {
            type: 'auction:new_lowest_bin', item_id: baseItem,
            item_name: data.lowest.item_name, price: data.lowest.price,
            auction_id: data.lowest.auction_id, timestamp: ts,
          }});
        }
      }
    }

    // --- Collect all cache writes into a single pipeline ---
    const cacheOps: CachePipelineEntry[] = [];

    // Diff lowest BINs against previous — only write changed entries
    let lbChanged = 0;
    let lbNew = 0;
    let lbRemoved = 0;
    const prevKeys = new Set(previousLowestBins.keys());

    for (const [baseItem, data] of lowestBins) {
      const prev = previousLowestBins.get(baseItem);
      prevKeys.delete(baseItem);
      if (!prev) {
        lbNew++;
        // New item — write per-item cache
        cacheOps.push({ tier: 'hot', resource: 'auction-lowest', id: baseItem, data, dataTimestamp: firstPage.lastUpdated });
        if (data.skyblock_id) cacheOps.push({ tier: 'hot', resource: 'auction-lowest-id', id: data.skyblock_id, data, dataTimestamp: firstPage.lastUpdated });
      } else if (data.lowest.price !== prev.lowest.price || data.count !== prev.count) {
        lbChanged++;
        // Changed item — update per-item cache
        cacheOps.push({ tier: 'hot', resource: 'auction-lowest', id: baseItem, data, dataTimestamp: firstPage.lastUpdated });
        if (data.skyblock_id) cacheOps.push({ tier: 'hot', resource: 'auction-lowest-id', id: data.skyblock_id, data, dataTimestamp: firstPage.lastUpdated });
      }
    }
    lbRemoved = prevKeys.size;
    // Note: removed items expire from Redis naturally via TTL

    const lbTotal = lowestBins.size;
    const lbDirty = lbChanged + lbNew + lbRemoved;

    // Only write bulk "all" keys if anything changed
    if (lbDirty > 0 && lbTotal > 0) {
      cacheOps.push({ tier: 'hot', resource: 'auction-lowest-all', id: 'latest', data: Object.fromEntries(lowestBins), dataTimestamp: firstPage.lastUpdated });
      const allById: Record<string, LowestBinData> = {};
      for (const data of lowestBins.values()) { if (data.skyblock_id) allById[data.skyblock_id] = data; }
      cacheOps.push({ tier: 'hot', resource: 'auction-lowest-all-by-id', id: 'latest', data: allById, dataTimestamp: firstPage.lastUpdated });
    }

    // Full tracked state only on FULL pass — pre-stringify in worker thread (large payloads)
    if (fullPass) {
      const cachedAt = firstPage.lastUpdated;
      const [activeJson, pendingJson] = await Promise.all([
        stringifyAsync({ data: Object.fromEntries(allTracked), cached_at: cachedAt }, allTracked.size),
        stringifyAsync({
          data: Object.fromEntries(Array.from(pendingAuctions.entries()).map(([id, p]) => [id, p.auction])),
          cached_at: cachedAt,
        }, pendingAuctions.size),
      ]);
      cacheOps.push({ tier: 'hot', resource: 'auctions-active', id: 'latest', data: null, rawJson: activeJson });
      cacheOps.push({ tier: 'hot', resource: 'auctions-pending', id: 'latest', data: null, rawJson: pendingJson });
    }

    // Cache seen auction item IDs for resource-items worker to set is_auctionable flags
    if (fullPass) {
      const seenAuctionItems: string[] = [];
      for (const auction of allTracked.values()) {
        if (auction.skyblock_id) seenAuctionItems.push(auction.skyblock_id);
      }
      // Deduplicate
      const uniqueItems = [...new Set(seenAuctionItems)];
      cacheOps.push({ tier: 'warm', resource: 'resources', id: 'seen-auction-items', data: uniqueItems, dataTimestamp: firstPage.lastUpdated });
    }

    // --- Fire publish + cache concurrently (independent I/O) ---
    await Promise.all([
      publishBatch(eventBatch),
      cacheSetPipeline(cacheOps),
    ]);

    // Stats
    const lbChangedPct = lbTotal > 0 ? Math.round((lbChanged / lbTotal) * 10000) / 100 : 0;

    previousLowestBins = lowestBins;

    // Compute auction change percentages
    const totalTracked = allTracked.size + added; // approximate pre-change total
    const addedPct = totalTracked > 0 ? Math.round((added / totalTracked) * 10000) / 100 : 0;
    const removedPct = totalTracked > 0 ? Math.round((removed / totalTracked) * 10000) / 100 : 0;

    const passMs = Date.now() - startTime;
    const flags = itemsAvailable ? '' : ' [NO ITEM RESOLUTION]';
    log.info(
      `Auctions ${passName} | +${added}(${addedPct}%) -${removed}(${removedPct}%) ~${updated} | tracked:${allTracked.size} pending:${pendingAuctions.size} | LB: ${lbTotal} items, ${lbChanged} changed(${lbChangedPct}%), +${lbNew} -${lbRemoved} | fetch:${fetchMs}ms total:${passMs}ms${flags}`,
    );

    return alerts;
  }

  // Publish + cache fast pass results (lightweight — skip full tracked state)
  await publishAndCache(fastLowestBins, fast.newListings, 'FAST',
    fast.added, fastRemoved, fast.updated, fastDuration, false);

  // ============ REMAINING PASS: pages 5+ (already fetching in parallel) ============

  if (remainPromises.length > 0) {
    const remainStart = Date.now();
    const remainingPages = await Promise.all(remainPromises);
    const remainingRaw: HypixelAuction[] = [];
    for (const p of remainingPages) {
      if (p?.success) {
        for (const a of p.auctions) {
          remainingRaw.push(a);
          seenIds.add(a.uuid);
        }
      }
    }

    const remainDuration = Date.now() - remainStart;

    // Add new auctions from remaining pages
    const remain = addAndUpdate(remainingRaw);

    // Full removal: expire past-end + remove anything not seen across all pages
    const fullRemoved = removeStale(seenIds);

    await storeItemBytes(remain.newItemBytes);

    const remainLowestBins = buildLowestBins();

    await publishAndCache(remainLowestBins, remain.newListings, 'FULL',
      remain.added, fullRemoved, remain.updated,
      remainDuration, true);
  } else {
    // No remaining pages — nothing extra to do
  }
}

// --- Ending-soon checker (independent of scan cycle) ---

function startEndingSoonChecker(): void {
  setInterval(async () => {
    if (allTracked.size === 0) return;

    const now = Date.now();
    const events: Array<{ channel: EventChannel; event: EventPayload }> = [];

    for (const [id, auction] of allTracked) {
      const timeLeft = auction.ends_at - now;
      if (timeLeft <= ENDING_SOON_WINDOW_MS && timeLeft > 0 && !notifiedEndingSoon.has(id)) {
        notifiedEndingSoon.add(id);
        events.push({
          channel: 'auction:ending',
          event: {
            type: 'auction:ending_soon',
            item_id: auction.base_item,
            item_name: auction.item_name,
            price: auction.price,
            auction_id: auction.auction_id,
            ends_at: auction.ends_at,
            timestamp: now,
          },
        });
      }
    }

    // Cleanup IDs for auctions no longer tracked
    for (const id of notifiedEndingSoon) {
      if (!allTracked.has(id)) notifiedEndingSoon.delete(id);
    }

    if (events.length > 0) {
      await publishBatch(events).catch((err) => log.warn({ err }, 'Failed to publish ending-soon events'));
      log.debug({ count: events.length }, 'Ending-soon alerts published');
    }
  }, ENDING_SOON_CHECK_INTERVAL_MS);
}

// --- Ended-auctions checker (independent timer, decoupled from scan cycle) ---

const ENDED_CHECK_INTERVAL_MS = 10_000; // Check every 10s

function startEndedAuctionsChecker(): void {
  setInterval(async () => {
    try {
      const { soldCount, expiredCount, endpointTotal } = await processEndedAuctions();
      if (soldCount > 0 || expiredCount > 0 || endpointTotal > 0) {
        log.info(`Auctions ended | recently_sold:${endpointTotal} matched:${soldCount} expired:${expiredCount} pending:${pendingAuctions.size}`);
      }
    } catch (err) {
      log.warn({ err }, 'Ended auctions check failed');
    }
  }, ENDED_CHECK_INTERVAL_MS);
}

// --- Startup ---

export function startAuctionScanner(): void {
  let running = false;

  // Run immediately on startup
  void processActiveAuctions().catch((err) => log.error({ err }, 'Initial auction scan failed'));

  // Poll every 1s with mutex to prevent overlapping runs
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processActiveAuctions();
    } catch (err) {
      log.error({ err }, 'Auction scan failed');
    } finally {
      running = false;
    }
  }, 1000);

  startEndingSoonChecker();
  startEndedAuctionsChecker();
}
