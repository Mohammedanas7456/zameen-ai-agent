import { config } from './config.js';
import type { Listing, Purpose, SearchFilters } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { extractListings, listingFromMetadata } from './listings.js';

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

/**
 * Retry policy for Vectara calls. Exported as a mutable object so tests can
 * zero the delay; production never changes it.
 *
 * 429 is a rate limit, 502/503/504 are Vectara's codes for an unreachable or
 * timed-out model provider — all of them clear on their own within seconds.
 * A 4xx other than 429 is our mistake and will not clear by retrying.
 */
export const retryPolicy = { attempts: 3, baseDelayMs: 500, maxRetryAfterMs: 5_000 };

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number, res: Response | null): number {
  const header = res?.headers.get('retry-after');
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, retryPolicy.maxRetryAfterMs);
  }
  return retryPolicy.baseDelayMs * 2 ** attempt;
}

/**
 * `fetch` with a short retry on transient failures.
 *
 * A request that already timed out is never retried: the caller chose that
 * timeout as the most it was willing to wait, and three of them in a row is
 * not what it meant. Network errors and retryable statuses are.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < retryPolicy.attempts; attempt++) {
    const last = attempt === retryPolicy.attempts - 1;
    try {
      const res = await fetch(url, init);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || last) return res;
      lastResponse = res;
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError' || last) throw err;
      lastResponse = null;
    }
    await sleep(retryDelay(attempt, lastResponse));
  }

  // Unreachable: the loop returns or throws on its last attempt.
  throw new UpstreamError('Retry loop exited without a response', 502);
}

/** Create a conversation session. Sessions carry the multi-turn context. */
export async function createSession(name: string): Promise<string> {
  const res = await fetchWithRetry(`${config.baseUrl}/agents/${config.agentKey}/sessions`, {
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
 * Weight of keyword matching in corpus search, 0 = pure neural. Vectara's
 * suggested starting point; enough for an exact token like a tower name or
 * "furnished" to count without letting keywords dominate.
 */
const LEXICAL_INTERPOLATION = 0.025;

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

  const res = await fetchWithRetry(`${config.baseUrl}/corpora/${config.corpusKey}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      // An empty query would match nothing useful; fall back to a broad one so
      // "filters only, no search terms" still returns the filtered set.
      query: query.trim() || 'property in Karachi',
      search: {
        ...(metadataFilter ? { metadata_filter: metadataFilter } : {}),
        lexical_interpolation: LEXICAL_INTERPOLATION,
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
 * `message` is whatever the agent should react to — the user's words, a
 * SEARCH RESULTS message with the listings a call retrieved, or the
 * SEARCH LIMIT message once a user message has used up its searches.
 */
export async function streamAgentTurn(sessionKey: string, message: string): Promise<Response> {
  const res = await fetchWithRetry(
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

/** Vectara document ids are `${purpose}-${externalId}`; anything outside this
 *  alphabet cannot be one, and would otherwise be interpolated into a URL path. */
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read one listing straight from the corpus.
 *
 * The booking route uses this instead of trusting the browser's copy: without
 * it, anyone could POST arbitrary text and have it land in the estate agent's
 * calendar.
 */
export async function getListingById(purpose: Purpose, externalId: string): Promise<Listing | null> {
  if (!SAFE_EXTERNAL_ID.test(externalId)) return null;

  const documentId = `${purpose}-${externalId}`;
  const res = await fetchWithRetry(
    `${config.baseUrl}/corpora/${config.corpusKey}/documents/${encodeURIComponent(documentId)}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new UpstreamError(`Could not read listing ${documentId} (HTTP ${res.status})`, res.status);
  }

  const data = (await res.json().catch(() => ({}))) as { metadata?: Record<string, unknown> };
  return data.metadata ? listingFromMetadata(data.metadata) : null;
}
