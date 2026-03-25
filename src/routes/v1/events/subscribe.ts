import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { subscribe } from '../../../services/event-bus.js';
import type { EventChannel, EventPayload } from '../../../services/event-bus.js';

interface Subscription {
  ws: WebSocket;
  channels: Set<EventChannel>;
  filters: Map<string, string>; // e.g. item_id -> "HYPERION"
}

const subscriptions = new Map<WebSocket, Subscription>();

function matchesFilter(event: EventPayload, sub: Subscription): boolean {
  if (sub.filters.size === 0) return true;

  for (const [key, value] of sub.filters) {
    if (key in event && (event as unknown as Record<string, unknown>)[key] !== value) {
      return false;
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
  filters?: Record<string, string>;
}

const ALL_CHANNELS: EventChannel[] = ['bazaar:alerts', 'auction:alerts', 'auction:ending', 'profile:changes'];

export async function setupWebSocket(server: Server): Promise<void> {
  const wss = new WebSocketServer({ server, path: '/v1/events/subscribe' });

  // Subscribe to all event channels and broadcast to matching WS clients
  for (const channel of ALL_CHANNELS) {
    await subscribe(channel, broadcastEvent);
  }

  wss.on('connection', (ws: WebSocket) => {
    const sub: Subscription = {
      ws,
      channels: new Set(),
      filters: new Map(),
    };
    subscriptions.set(ws, sub);

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as SubscribeMessage;

        if (msg.action === 'subscribe' && msg.channel) {
          sub.channels.add(msg.channel);
          if (msg.filters) {
            for (const [key, value] of Object.entries(msg.filters)) {
              sub.filters.set(key, value);
            }
          }
          ws.send(JSON.stringify({ status: 'subscribed', channel: msg.channel }));
        }

        if (msg.action === 'unsubscribe' && msg.channel) {
          sub.channels.delete(msg.channel);
          ws.send(JSON.stringify({ status: 'unsubscribed', channel: msg.channel }));
        }
      } catch {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      subscriptions.delete(ws);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      status: 'connected',
      available_channels: ALL_CHANNELS,
      usage: 'Send {"action":"subscribe","channel":"bazaar:alerts"} to subscribe',
    }));
  });
}
