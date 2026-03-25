import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { subscribe } from '../../../services/event-bus.js';
import type { EventPayload } from '../../../services/event-bus.js';

export async function sseRoute(app: FastifyInstance): Promise<void> {
  const sseClients = new Set<FastifyReply>();
  let subscribed = false;

  async function ensureSubscribed(): Promise<void> {
    if (subscribed) return;
    subscribed = true;
    await subscribe('bazaar:alerts', (_channel: string, event: EventPayload) => {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of sseClients) {
        client.raw.write(data);
      }
    });
  }

  app.get(
    '/v1/events/bazaar/stream',
    {},
    async (request: FastifyRequest, reply: FastifyReply) => {
      await ensureSubscribed();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial keepalive
      reply.raw.write(':ok\n\n');

      sseClients.add(reply);

      request.raw.on('close', () => {
        sseClients.delete(reply);
      });

      // Keep the connection open — Fastify must not auto-close
      await reply.hijack();
    },
  );
}
