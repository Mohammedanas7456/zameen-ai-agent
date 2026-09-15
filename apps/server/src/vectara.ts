import { config } from './config.js';
import type { Listing, SearchFilters } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { extractListings } from './listings.js';

const headers = {
  'x-api-key': config.apiKey,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Create a conversation session. Sessions carry the multi-turn context. */
export async function createSession(name: string): Promise<string> {
  const res = await fetch(`${config.baseUrl}/agents/${config.agentKey}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, metadata: { app: 'zameen-ai-agent' } }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new UpstreamError(`Could not start a session (HTTP ${res.status})`, res.status);
  }
  const data = (await res.json()) as { key?: string };
  if (!data.key) throw new UpstreamError('Session response had no key', 502);
  return data.key;
}

/**
 * Deterministic structured search, bypassing the agent entirely.
 *
 * The sidebar uses this: filters the user set by hand are translated to a
 * metadata filter in TypeScript, so they are enforced exactly and cost no LLM
 * round-trip.
 */
export async function searchListings(
  filters: SearchFilters,
  query: string,
  limit = 40,
): Promise<Listing[]> {
  const metadataFilter = buildMetadataFilter(filters);

  const res = await fetch(`${config.baseUrl}/corpora/${config.corpusKey}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      // An empty query would match nothing useful; fall back to a broad one so
      // "filters only, no search terms" still returns the filtered set.
      query: query.trim() || 'property in Karachi',
      search: {
        ...(metadataFilter ? { metadata_filter: metadataFilter } : {}),
        limit,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new UpstreamError(`Search failed (HTTP ${res.status}): ${body.slice(0, 200)}`, res.status);
  }

  return extractListings(await res.json(), limit);
}

/**
 * Open the agent's SSE stream for one conversation turn.
 *
 * `message` is whatever the agent should react to — either the user's words or,
 * on the second phase of a search, the listings we retrieved for it.
 */
export async function streamAgentTurn(sessionKey: string, message: string): Promise<Response> {
  const res = await fetch(
    `${config.baseUrl}/agents/${config.agentKey}/sessions/${sessionKey}/events`,
    {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({
        messages: [{ type: 'text', content: message }],
        stream_response: true,
      }),
      // Agent turns can run several tool calls; allow generous headroom.
      signal: AbortSignal.timeout(300_000),
    },
  );

  if (!res.ok || !res.body) {
    const body = res.body ? await res.text() : '';
    throw new UpstreamError(`Agent turn failed (HTTP ${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return res;
}
