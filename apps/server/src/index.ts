import express from 'express';
import cors from 'cors';
import { join } from 'node:path';
import { config, ROOT } from './config.js';
import { getFacets } from './facets.js';
import { mountAuthRoutes } from './routes/auth.js';
import { mountBookingRoutes } from './routes/booking.js';
import { mountChatRoutes } from './routes/chat.js';
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

mountChatRoutes(app);
mountAuthRoutes(app);
mountBookingRoutes(app);

// Mounted last so it can never shadow an /api route above it.
mountWebClient(app, join(ROOT, 'apps', 'web', 'dist'));

app.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}`);
  console.log(`  corpus: ${config.corpusKey}`);
  console.log(`  agent:  ${config.agentKey}`);
});
