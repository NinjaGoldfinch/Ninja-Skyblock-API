import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { subscribe } from '../../../services/event-bus.js';
import type { EventChannel, EventPayload } from '../../../services/event-bus.js';

function createSSEStream(
  app: FastifyInstance,
  path: string,
  channels: EventChannel[],
): void {
  const clients = new Set<FastifyReply>();
  let subscribed = false;

  async function ensureSubscribed(): Promise<void> {
    if (subscribed) return;
    subscribed = true;
    for (const channel of channels) {
      await subscribe(channel, (_ch: string, event: EventPayload) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) {
          client.raw.write(data);
        }
      });
    }
  }

  app.get(path, {}, async (request: FastifyRequest, reply: FastifyReply) => {
    await ensureSubscribed();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write(':ok\n\n');
    clients.add(reply);

    request.raw.on('close', () => {
      clients.delete(reply);
    });

    await reply.hijack();
  });
}

export async function sseRoute(app: FastifyInstance): Promise<void> {
  // Bazaar price changes
  createSSEStream(app, '/v1/events/bazaar/stream', ['bazaar:alerts']);

  // All auction events (sold, new listings, lowest BIN changes, ending soon)
  createSSEStream(app, '/v1/events/auctions/stream', [
    'auction:alerts', 'auction:sold', 'auction:new-listing',
    'auction:lowest-bin-change', 'auction:ending',
  ]);

  // Auction sold only
  createSSEStream(app, '/v1/events/auctions/sold', ['auction:sold']);

  // Lowest BIN changes only
  createSSEStream(app, '/v1/events/auctions/lowest', ['auction:lowest-bin-change']);

  // New listings only
  createSSEStream(app, '/v1/events/auctions/listings', ['auction:new-listing']);

  // Profile changes
  createSSEStream(app, '/v1/events/profiles/stream', ['profile:changes']);
}
