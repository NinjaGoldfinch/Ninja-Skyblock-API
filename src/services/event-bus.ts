import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export type EventChannel =
  | 'bazaar:alerts'
  | 'auction:alerts'
  | 'auction:ending'
  | 'auction:sold'
  | 'auction:new-listing'
  | 'auction:lowest-bin-change'
  | 'profile:changes';

export interface BazaarAlertEvent {
  type: 'bazaar:price_change';
  item_id: string;
  old_instant_buy_price: number;
  new_instant_buy_price: number;
  old_instant_sell_price: number;
  new_instant_sell_price: number;
  old_avg_buy_price: number;
  new_avg_buy_price: number;
  old_avg_sell_price: number;
  new_avg_sell_price: number;
  change_pct: number;
  timestamp: number;
}

export interface AuctionAlertEvent {
  type: 'auction:new_lowest_bin';
  item_id: string;
  item_name: string;
  price: number;
  auction_id: string;
  timestamp: number;
}

export interface AuctionEndingEvent {
  type: 'auction:ending_soon';
  item_id: string;
  item_name: string;
  price: number;
  auction_id: string;
  ends_at: number;
  timestamp: number;
}

export interface AuctionSoldEvent {
  type: 'auction:sold';
  auction_id: string;
  skyblock_id: string | null;
  base_item: string;
  item_name: string;
  seller_uuid: string;
  buyer_uuid: string | null;
  price: number;
  bin: boolean;
  timestamp: number;
}

export interface AuctionNewListingEvent {
  type: 'auction:new-listing';
  auction_id: string;
  skyblock_id: string | null;
  base_item: string;
  item_name: string;
  price: number;
  seller_uuid: string;
  ends_at: number;
  bin: boolean;
  tier: string;
  timestamp: number;
}

export interface AuctionLowestBinChangeEvent {
  type: 'auction:lowest-bin-change';
  skyblock_id: string | null;
  base_item: string;
  old_price: number;
  new_price: number;
  auction_id: string;
  item_name: string;
  change_pct: number;
  timestamp: number;
}

export interface ProfileChangeEvent {
  type: 'profile:change';
  player_uuid: string;
  profile_uuid: string;
  changes: string[];
  timestamp: number;
}

export type EventPayload =
  | BazaarAlertEvent
  | AuctionAlertEvent
  | AuctionEndingEvent
  | AuctionSoldEvent
  | AuctionNewListingEvent
  | AuctionLowestBinChangeEvent
  | ProfileChangeEvent;

type EventHandler = (channel: string, event: EventPayload) => void;

// Separate Redis connection for pub/sub (ioredis requirement —
// a client in subscriber mode can't run other commands)
let pubClient: Redis | null = null;
let subClient: Redis | null = null;
const handlers: EventHandler[] = [];
let messageListenerAttached = false;

function getPubClient(): Redis {
  if (!pubClient) {
    pubClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return pubClient;
}

function getSubClient(): Redis {
  if (!subClient) {
    subClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });

    // Attach message listener once
    subClient.on('message', (ch: string, message: string) => {
      const event = JSON.parse(message) as EventPayload;
      for (const h of handlers) {
        h(ch, event);
      }
    });
    messageListenerAttached = true;
  }
  return subClient;
}

export async function publish(channel: EventChannel, event: EventPayload): Promise<void> {
  const client = getPubClient();
  await client.publish(channel, JSON.stringify(event));
}

export async function publishBatch(events: Array<{ channel: EventChannel; event: EventPayload }>): Promise<void> {
  if (events.length === 0) return;
  const client = getPubClient();
  const pipeline = client.pipeline();
  for (const { channel, event } of events) {
    pipeline.publish(channel, JSON.stringify(event));
  }
  await pipeline.exec();
}

export async function subscribe(channel: EventChannel, handler: EventHandler): Promise<void> {
  const client = getSubClient();
  handlers.push(handler);
  void messageListenerAttached; // listener is set up in getSubClient
  await client.subscribe(channel);
}

export async function closeEventBus(): Promise<void> {
  if (pubClient) {
    await pubClient.quit();
    pubClient = null;
  }
  if (subClient) {
    await subClient.quit();
    subClient = null;
  }
  handlers.length = 0;
}
