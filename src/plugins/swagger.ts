import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

export const swaggerPlugin = fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ninja Skyblock API',
        description: 'Backend API proxying and extending the Hypixel API for SkyBlock endpoints.',
        version: '1.0.0',
        contact: {
          name: 'API Support',
        },
      },
      servers: [
        {
          url: env.NODE_ENV === 'production'
            ? 'https://api.yourdomain.com'
            : `http://localhost:${env.PORT}`,
          description: env.NODE_ENV === 'production' ? 'Production' : 'Local development',
        },
      ],
      tags: [
        { name: 'skyblock', description: 'SkyBlock profile, skills, networth, and dungeon endpoints' },
        { name: 'bazaar', description: 'Bazaar pricing, live data, and price history' },
        { name: 'auctions', description: 'Auction house lookups and lowest BIN tracking' },
        { name: 'events', description: 'Real-time event streams (SSE and WebSocket)' },
        { name: 'player', description: 'Minecraft player lookups (UUID resolution)' },
        { name: 'admin', description: 'Administrative endpoints (API key management)' },
        { name: 'health', description: 'Service health and status' },
      ],
      components: {
        securitySchemes: {
          hmac: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Signature',
            description: 'HMAC-SHA256 signature over request body + timestamp',
          },
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'API key for public consumers',
          },
        },
      },
    },
  });
});
