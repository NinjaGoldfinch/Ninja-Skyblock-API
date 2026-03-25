import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';

export async function specRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/docs/openapi.json', async () => {
    return app.swagger();
  });

  app.get('/v1/docs/openapi.yaml', async (_request, reply) => {
    reply.type('text/yaml');
    return yaml.stringify(app.swagger());
  });
}
