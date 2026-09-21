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

/** What a caller is willing to have repeated on its behalf. */
export interface RetryOptions {
  /** Statuses worth another attempt. Defaults to `RETRYABLE_STATUSES`. */
  retryable?: ReadonlySet<number>;
  /** Retry a request that never got an answer at all. Defaults to true. */
  networkErrors?: boolean;
}

/**
 * `fetch` with a short retry on transient failures.
 *
 * A request that already timed out is never retried: the caller chose that
 * timeout as the most it was willing to wait, and three of them in a row is
 * not what it meant. Network errors and retryable statuses are.
 *
 * Callers must be idempotent under the statuses they retry — a request that
 * changes state upstream has to narrow `options` to the failures that cannot
 * have reached it. The `AbortSignal` in `init` is shared across attempts by
 * design, so the caller's timeout is a total budget rather than a per-attempt
 * one.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const retryable = options.retryable ?? RETRYABLE_STATUSES;
  const retryNetworkErrors = options.networkErrors ?? true;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < retryPolicy.attempts; attempt++) {
    const last = attempt === retryPolicy.attempts - 1;
    try {
      const res = await fetch(url, init);
      if (res.ok || !retryable.has(res.status) || last) return res;
      // Nobody will read this one, and undici keeps the connection checked out
      // until a body is consumed or cancelled — so release it before asking
      // for another. Its headers survive cancellation, which is all
      // `retryDelay` needs.
      void res.body?.cancel().catch(() => {});
      lastResponse = res;
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError' || last || !retryNetworkErrors) throw err;
      lastResponse = null;
    }
    await sleep(retryDelay(attempt, lastResponse));
  }

  // Unreachable: the loop returns or throws on its last attempt.
  throw new UpstreamError('Retry loop exited without a response', 502);
}

/**
 * How long a session survives without a message. A week covers the browser's
 * chat history for any realistic gap; after that the next message gets a 404,
 * which the route reports as `session_expired` so the client can start over.
 */
const SESSION_TTI_MINUTES = 7 * 24 * 60;

/** Create a conversation session. Sessions carry the multi-turn context. */
export async function createSession(name: string): Promise<string> {
  const res = await fetchWithRetry(`${config.baseUrl}/agents/${config.agentKey}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, metadata: { app: 'zameen-ai-agent' }, tti_minutes: SESSION_TTI_MINUTES }),
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
 *
 * `signal` is the caller's own abort — the browser having gone away. Joined
 * to the timeout so an abort reaches the socket immediately: without it, a
 * read already pending on Vectara's next chunk would keep waiting for it.
 */
export async function streamAgentTurn(
  sessionKey: string,
  message: string,
  signal?: AbortSignal,
): Promise<Response> {
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
      signal: signal ? AbortSignal.any([AbortSignal.timeout(300_000), signal]) : AbortSignal.timeout(300_000),
    },
    // A turn is not idempotent. A network error after the request was sent,
    // or a 503/504 from a gateway whose upstream is still working, would
    // append the user's message a second time and bill a turn nobody reads.
    // A 429 is the one refusal that is certain never to have reached the agent.
    { retryable: new Set([429]), networkErrors: false },
  );

  if (!res.ok || !res.body) {
    const body = res.body ? await res.text() : '';
    throw new UpstreamError(`Agent turn failed (HTTP ${res.status}): ${body.slice(0, 200)}`, res.status);
  }
  return res;
}

/**
 * Ask Vectara to stop the turn in flight for a session.
 *
 * Called when the browser has gone away mid-turn. Nobody will read the reply,
 * so the only thing finishing it would do is bill for it. One attempt, no
 * retry: if this fails the turn just runs to completion as it did before.
 */
export async function interruptTurn(sessionKey: string): Promise<void> {
  const res = await fetch(`${config.baseUrl}/agents/${config.agentKey}/sessions/${sessionKey}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'interrupt', stream_response: false }),
    signal: AbortSignal.timeout(10_000),
  });
  // Vectara answers 400 with "Nothing to interrupt, session is not running":
  // the turn finished between the client leaving and this call. That is the
  // outcome we wanted, not a failure worth logging.
  if (res.status === 400) return;
  if (!res.ok) throw new UpstreamError(`Interrupt failed (HTTP ${res.status})`, res.status);
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
