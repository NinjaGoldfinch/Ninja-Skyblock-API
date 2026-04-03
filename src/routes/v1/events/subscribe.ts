import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { subscribe } from '../../../services/event-bus.js';
import type { EventChannel, EventPayload } from '../../../services/event-bus.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('websocket');

interface PriceThreshold {
  field: string;       // e.g. "new_instant_buy_price", "price"
  operator: 'lt' | 'gt' | 'lte' | 'gte';
  value: number;
}

interface SubscriptionFilter {
  item_ids?: string[];           // match any of these item IDs/names
  price_thresholds?: PriceThreshold[];
}

interface Subscription {
  ws: WebSocket;
  channels: Set<EventChannel>;
  filter: SubscriptionFilter;
}

const subscriptions = new Map<WebSocket, Subscription>();

function matchesFilter(event: EventPayload, sub: Subscription): boolean {
  const filter = sub.filter;
  const eventRecord = event as unknown as Record<string, unknown>;

  // Item filter: match item_id, item_name, base_item, or skyblock_id against the list
  if (filter.item_ids && filter.item_ids.length > 0) {
    const eventItemId = (eventRecord['item_id'] as string | undefined) ?? '';
    const eventItemName = (eventRecord['item_name'] as string | undefined) ?? '';
    const eventBaseItem = (eventRecord['base_item'] as string | undefined) ?? '';
    const eventSkyblockId = (eventRecord['skyblock_id'] as string | undefined) ?? '';
    const matched = filter.item_ids.some((id) => {
      const lower = id.toLowerCase();
      return eventItemId.toLowerCase() === lower
        || eventItemName.toLowerCase() === lower
        || eventBaseItem.toLowerCase() === lower
        || eventSkyblockId.toLowerCase() === lower;
    });
    if (!matched) return false;
  }

  // Price thresholds
  if (filter.price_thresholds && filter.price_thresholds.length > 0) {
    for (const threshold of filter.price_thresholds) {
      const fieldValue = eventRecord[threshold.field];
      if (typeof fieldValue !== 'number') continue;

      switch (threshold.operator) {
        case 'lt':  if (!(fieldValue < threshold.value)) return false; break;
        case 'gt':  if (!(fieldValue > threshold.value)) return false; break;
        case 'lte': if (!(fieldValue <= threshold.value)) return false; break;
        case 'gte': if (!(fieldValue >= threshold.value)) return false; break;
      }
    }
  }

  return true;
}

function broadcastEvent(channel: string, event: EventPayload): void {
  for (const sub of subscriptions.values()) {
    if (!sub.channels.has(channel as EventChannel)) continue;
    if (!matchesFilter(event, sub)) continue;

    if (sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(JSON.stringify({ channel, ...event }));
    }
  }
}

interface SubscribeMessage {
  action: 'subscribe' | 'unsubscribe';
  channel: EventChannel;
  filters?: {
    item_ids?: string[];
    price_thresholds?: PriceThreshold[];
  };
}

const ALL_CHANNELS: EventChannel[] = [
  'bazaar:alerts',
  'auction:alerts', 'auction:sold', 'auction:new-listing',
  'auction:lowest-bin-change', 'auction:price-updates', 'auction:ending',
  'profile:changes',
];

export async function setupWebSocket(server: Server): Promise<void> {
  const wss = new WebSocketServer({ server, path: '/v1/events/subscribe' });

  for (const channel of ALL_CHANNELS) {
    await subscribe(channel, broadcastEvent);
  }

  wss.on('connection', (ws: WebSocket) => {
    const sub: Subscription = {
      ws,
      channels: new Set(),
      filter: {},
    };
    subscriptions.set(ws, sub);

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as SubscribeMessage;

        if (msg.action === 'subscribe' && msg.channel) {
          sub.channels.add(msg.channel);
          if (msg.filters) {
            if (msg.filters.item_ids) {
              sub.filter.item_ids = [
                ...(sub.filter.item_ids ?? []),
                ...msg.filters.item_ids,
              ];
            }
            if (msg.filters.price_thresholds) {
              sub.filter.price_thresholds = [
                ...(sub.filter.price_thresholds ?? []),
                ...msg.filters.price_thresholds,
              ];
            }
          }
          log.info({
            channel: msg.channel,
            item_ids: sub.filter.item_ids,
            thresholds: sub.filter.price_thresholds?.length ?? 0,
          }, 'Client subscribed');
          ws.send(JSON.stringify({ status: 'subscribed', channel: msg.channel, filters: sub.filter }));
        }

        if (msg.action === 'unsubscribe' && msg.channel) {
          sub.channels.delete(msg.channel);
          log.info({ channel: msg.channel }, 'Client unsubscribed');
          ws.send(JSON.stringify({ status: 'unsubscribed', channel: msg.channel }));
        }
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      subscriptions.delete(ws);
    });

    ws.send(JSON.stringify({
      status: 'connected',
      available_channels: ALL_CHANNELS,
      usage: {
        subscribe_all: '{"action":"subscribe","channel":"bazaar:alerts"}',
        subscribe_items: '{"action":"subscribe","channel":"bazaar:alerts","filters":{"item_ids":["ENCHANTED_DIAMOND","BOOSTER_COOKIE"]}}',
        subscribe_threshold: '{"action":"subscribe","channel":"auction:alerts","filters":{"item_ids":["Hyperion"],"price_thresholds":[{"field":"price","operator":"lt","value":600000000}]}}',
        unsubscribe: '{"action":"unsubscribe","channel":"bazaar:alerts"}',
      },
    }));
  });
}
