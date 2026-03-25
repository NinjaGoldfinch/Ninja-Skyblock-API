import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export type EventChannel =
  | 'bazaar:alerts'
  | 'auction:alerts'
  | 'auction:ending'
  | 'profile:changes';

export interface BazaarAlertEvent {
  type: 'bazaar:price_change';
  item_id: string;
  old_buy_price: number;
  new_buy_price: number;
  old_sell_price: number;
  new_sell_price: number;
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
