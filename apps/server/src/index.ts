import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Facets, SearchFilters } from '@zameen/shared';
import { config, ROOT } from './config.js';
import { createSession, searchListings, streamAgentTurn, UpstreamError } from './vectara.js';
import { extractListings } from './listings.js';
import { SseParser, describeToolInput, type ClientEvent } from './sse.js';

const app = express();
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '256kb' }));

/** Facets are static for a snapshot, so read once and keep them in memory. */
let facetsCache: Facets | null = null;
async function getFacets(): Promise<Facets> {
  if (!facetsCache) {
    facetsCache = JSON.parse(await readFile(join(ROOT, 'data', 'facets.json'), 'utf8')) as Facets;
  }
  return facetsCache;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, corpus: config.corpusKey, agent: config.agentKey });
});

app.get('/api/facets', async (_req, res) => {
  try {
    res.json(await getFacets());
  } catch {
    res.status(500).json({ error: 'Facets unavailable. Run "npm run normalize" first.' });
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
 * One conversation turn, streamed.
 *
 * Vectara's SSE is translated into a smaller UI-shaped stream: prose tokens for
 * the chat, and a `listings` event carrying the structured results so the
 * result grid and sidebar update from the same search the agent just ran.
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

  try {
    const agentRes = await streamAgentTurn(sessionKey, message);
    const reader = agentRes.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let lastFilter = '';
    let sawOutput = false;

    // If the client navigates away, stop pulling from Vectara.
    let aborted = false;
    req.on('close', () => {
      aborted = true;
      void reader.cancel().catch(() => {});
    });

    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const sse of parser.push(decoder.decode(value, { stream: true }))) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(sse.data) as Record<string, unknown>;
        } catch {
          continue; // keep-alives and non-JSON frames
        }

        switch (event['type']) {
          case 'streaming_agent_output': {
            const text = typeof event['content'] === 'string' ? event['content'] : '';
            if (text) {
              sawOutput = true;
              send({ type: 'token', text });
            }
            break;
          }
          case 'agent_output': {
            // Non-streamed fallback: only use it if nothing streamed, or the
            // whole reply would be duplicated.
            const text = typeof event['content'] === 'string' ? event['content'] : '';
            if (text && !sawOutput) {
              sawOutput = true;
              send({ type: 'token', text });
            }
            break;
          }
          case 'thinking': {
            const text = typeof event['content'] === 'string' ? event['content'] : '';
            if (text) send({ type: 'thinking', text: text.slice(0, 200) });
            break;
          }
          case 'tool_input': {
            const { query, filter } = describeToolInput(event['tool_input']);
            lastFilter = filter;
            send({
              type: 'tool_start',
              tool: String(event['tool_configuration_name'] ?? 'search_properties'),
              query,
              filter,
            });
            break;
          }
          case 'tool_output': {
            const listings = extractListings(event['tool_output']);
            if (listings.length > 0) send({ type: 'listings', listings, filter: lastFilter });
            break;
          }
          default:
            break;
        }
      }
    }

    send({ type: 'done' });
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
  } finally {
    res.end();
  }
});

app.listen(config.port, () => {
  console.log(`API on http://localhost:${config.port}`);
  console.log(`  corpus: ${config.corpusKey}`);
  console.log(`  agent:  ${config.agentKey}`);
});
