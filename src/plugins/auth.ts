import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { errors } from '../utils/errors.js';

const MAX_TIMESTAMP_DRIFT_MS = 300_000; // 5 minutes

declare module 'fastify' {
  interface FastifyRequest {
    clientId: string;
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

  app.addHook('onRequest', async (request) => {
    // Skip auth for health check
    if (request.url === '/v1/health') {
      request.clientId = 'anonymous';
      return;
    }

    verifyHmacSignature(request);
    request.clientId = 'hmac-client';
  });
});
