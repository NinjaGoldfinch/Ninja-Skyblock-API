import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateApiKey } from '../../../services/api-key-manager.js';
import { errors } from '../../../utils/errors.js';

interface CreateKeyBody {
  owner: string;
  tier?: string;
  rate_limit?: number;
}

export async function adminKeysRoute(app: FastifyInstance): Promise<void> {
  // POST /v1/admin/keys — generate a new API key (internal/HMAC auth only)
  app.post<{ Body: CreateKeyBody }>(
    '/v1/admin/keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['owner'],
          properties: {
            owner: { type: 'string' },
            tier: { type: 'string', enum: ['public', 'internal', 'bot'], default: 'public' },
            rate_limit: { type: 'integer', minimum: 1, maximum: 1000, default: 30 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateKeyBody }>) => {
      // Only internal/dev clients can generate keys
      if (request.clientTier !== 'internal') {
        throw errors.forbidden('Only internal clients can generate API keys.');
      }

      const { owner, tier, rate_limit: rateLimit } = request.body;
      const rawKey = await generateApiKey(owner, tier ?? 'public', rateLimit ?? 30);

      return {
        success: true,
        data: {
          key: rawKey,
          owner,
          tier: tier ?? 'public',
          rate_limit: rateLimit ?? 30,
          note: 'Store this key securely. It cannot be retrieved again.',
        },
        meta: { cached: false, cache_age_seconds: null, timestamp: Date.now() },
      };
    },
  );
}
