import type { FastifyInstance } from 'fastify';

const REDOC_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Ninja Skyblock API — Documentation</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('/v1/docs/openapi.json', {
      theme: {
        colors: { primary: { main: '#4F46E5' } },
        typography: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          headings: { fontFamily: 'system-ui, -apple-system, sans-serif' },
        },
      },
      hideDownloadButton: false,
      expandResponses: '200',
      pathInMiddlePanel: true,
      sortTagsAlphabetically: true,
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

export async function redocRoute(app: FastifyInstance): Promise<void> {
  app.get('/v1/docs', async (_request, reply) => {
    reply.type('text/html');
    return REDOC_HTML;
  });
}
