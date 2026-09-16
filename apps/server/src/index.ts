import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { join } from 'node:path';
import type { SearchFilters } from '@zameen/shared';
import { config, ROOT } from './config.js';
import { createSession, searchListings, UpstreamError } from './vectara.js';
import { handleUserMessage } from './chat.js';
import { getFacets } from './facets.js';
import type { ClientEvent } from './sse.js';
import { mountAuthRoutes } from './routes/auth.js';
import { mountBookingRoutes } from './routes/booking.js';
import { mountWebClient } from './static.js';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, corpus: config.corpusKey, agent: config.agentKey });
});

app.get('/api/facets', async (_req, res) => {
  try {
    res.json(await getFacets());
  } catch (err) {
    res.status(502).json({ error: `Could not read the corpus: ${(err as Error).message}` });
  }
});

app.post('/api/session', async (_req, res) => {
  try {
    const key = await createSession(`web-${Date.now()}`);
    res.json({ sessionKey: key });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * Deterministic search for the filter sidebar — no LLM in the path, so the
 * filters the user set are exactly the filters applied.
 */
app.post('/api/search', async (req: Request, res: Response) => {
  const { filters = {}, query = '' } = req.body as { filters?: SearchFilters; query?: string };
  try {
    const listings = await searchListings(filters, query);
    res.json({ listings });
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/**
 * One user message, streamed.
 *
 * A search runs as two agent turns with our own exact query in between; see
 * `handleUserMessage`.
 */
app.post('/api/chat', async (req: Request, res: Response) => {
  const { sessionKey, message } = req.body as { sessionKey?: string; message?: string };
  if (!sessionKey || !message?.trim()) {
    res.status(400).json({ error: 'sessionKey and message are required' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this an nginx in front would buffer the whole stream.
    'X-Accel-Buffering': 'no',
  });

  const send = (event: ClientEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // If the client navigates away, stop doing work on its behalf.
  //
  // This must be `res`, not `req`: the request stream emits 'close' as soon as
  // its body has been read, which is immediately — watching `req` aborts every
  // turn before it starts.
  let aborted = false;
  res.on('close', () => {
    aborted = true;
  });

  try {
    await handleUserMessage(sessionKey, message, send, () => aborted);
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
  } finally {
    res.end();
  }
});

mountAuthRoutes(app);
mountBookingRoutes(app);

// Mounted last so it can never shadow an /api route above it.
mountWebClient(app, join(ROOT, 'apps', 'web', 'dist'));

app.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}`);
  console.log(`  corpus: ${config.corpusKey}`);
  console.log(`  agent:  ${config.agentKey}`);
});
