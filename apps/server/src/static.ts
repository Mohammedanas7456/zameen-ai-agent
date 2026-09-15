import express, { type Express } from 'express';
import { join } from 'node:path';

/**
 * Serve the built web client from the same origin as the API.
 *
 * Same-origin is load-bearing, not a convenience: the client addresses the API
 * with relative paths (`/api/...`), and the SSE stream on /api/chat wants as
 * few proxies between browser and Express as possible.
 *
 * Mount this AFTER the /api routes. The deep-link fallback deliberately skips
 * /api so an unknown endpoint still 404s, instead of handing the SPA shell to
 * a fetch() that is expecting JSON.
 */
export function mountWebClient(app: Express, distDir: string): void {
  app.use(express.static(distDir));

  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(join(distDir, 'index.html'));
  });
}
