import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { errors } from '../utils/errors.js';
import { validateApiKey } from '../services/api-key-manager.js';

const MAX_TIMESTAMP_DRIFT_MS = 300_000; // 5 minutes

// Routes accessible without authentication (public data endpoints)
const PUBLIC_PREFIXES = [
  '/v1/skyblock/bazaar',
  '/v2/skyblock/bazaar',
  '/v1/skyblock/auctions',
  '/v2/skyblock/auctions',
  '/v1/skyblock/resources',
  '/v2/skyblock/items',
  '/v1/skyblock/firesales',
  '/v1/skyblock/news',
  '/v1/skyblock/bingo/goals',
  '/v1/docs',
];

function isPublicRoute(url: string): boolean {
  return PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p + '/'));
}

declare module 'fastify' {
  interface FastifyRequest {
    clientId: string;
    clientTier: string;
    clientRateLimit: number;
  }
}

function verifyHmacSignature(request: FastifyRequest): void {
  const signature = request.headers['x-signature'] as string | undefined;
  const timestamp = request.headers['x-timestamp'] as string | undefined;

  if (!signature || !timestamp) {
    throw errors.unauthorized('Missing X-Signature or X-Timestamp header.');
  }

  // Replay protection: reject timestamps too far in the past or future
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) {
    throw errors.unauthorized('Invalid X-Timestamp header.');
  }

  const drift = Math.abs(Date.now() - requestTime);
  if (drift > MAX_TIMESTAMP_DRIFT_MS) {
    throw errors.unauthorized('Request timestamp is too far from server time.');
  }

  // Compute expected signature: HMAC-SHA256(secret, timestamp + body)
  const body = typeof request.body === 'string'
    ? request.body
    : request.body ? JSON.stringify(request.body) : '';

  const payload = `${timestamp}${body}`;
  const expected = createHmac('sha256', env.HMAC_SECRET)
    .update(payload)
    .digest('hex');

  // Timing-safe comparison
  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw errors.unauthorized('Invalid HMAC signature.');
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('clientId', '');
  app.decorateRequest('clientTier', 'public');
  app.decorateRequest('clientRateLimit', env.PUBLIC_RATE_LIMIT);

  app.addHook('onRequest', async (request) => {
    // Routes that never require authentication
    const url = request.url.split('?')[0];
    if (url === '/v1/health' || url.startsWith('/v1/events/')) {
      request.clientId = 'anonymous';
      request.clientTier = 'anonymous';
      request.clientRateLimit = env.CLIENT_RATE_LIMIT;
      return;
    }

    // Skip auth in dev when DEV_AUTH_BYPASS is enabled
    if (env.DEV_AUTH_BYPASS) {
      request.clientId = 'dev-bypass';
      request.clientTier = 'internal';
      request.clientRateLimit = env.CLIENT_RATE_LIMIT;
      return;
    }

    // Try HMAC auth first (Fabric mod)
    const signature = request.headers['x-signature'] as string | undefined;
    if (signature) {
      verifyHmacSignature(request);
      request.clientId = 'hmac-client';
      request.clientTier = 'internal';
      request.clientRateLimit = env.CLIENT_RATE_LIMIT;
      return;
    }

    // Try API key auth (public consumers, Discord bot)
    const apiKey = request.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      const keyInfo = await validateApiKey(apiKey);
      if (!keyInfo) {
        throw errors.unauthorized('Invalid or inactive API key.');
      }
      request.clientId = `apikey:${keyInfo.owner}`;
      request.clientTier = keyInfo.tier;
      request.clientRateLimit = keyInfo.rate_limit;
      return;
    }

    // Public endpoints — no auth required, rate-limit by IP
    if (isPublicRoute(url)) {
      request.clientId = `ip:${request.ip}`;
      request.clientTier = 'public';
      request.clientRateLimit = env.PUBLIC_RATE_LIMIT;
      return;
    }

    throw errors.unauthorized('Missing authentication. Provide X-Signature (HMAC) or X-API-Key header.');
  });
});
