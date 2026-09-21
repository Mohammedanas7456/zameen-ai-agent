import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { UpstreamError, createSession, fetchWithRetry, getListingById, interruptTurn, retryPolicy, searchListings, streamAgentTurn } from './vectara.js';

afterEach(() => vi.unstubAllGlobals());

const originalDelay = retryPolicy.baseDelayMs;
beforeEach(() => {
  retryPolicy.baseDelayMs = 0;
});
afterEach(() => {
  retryPolicy.baseDelayMs = originalDelay;
});

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const METADATA = {
  external_id: '12345', title: 'Well maintained 3 bed flat', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', property_type: 'Flats', bedrooms: 3, bathrooms: 2,
  price_pkr: 250000, price_label: 'PKR 2.5 Lakh', area_sqft: 1800, area_sqyd: 200,
  city: 'Karachi', area_l3: 'Clifton', area_l4: 'Block 2', area_l5: '',
  area_path: 'Karachi > Clifton > Block 2', floor: 'upper', floor_num: -1, is_verified: true,
};

describe('getListingById', () => {
  it('reads the document whose id is purpose-externalId', async () => {
    const spy = stubFetch({ id: 'rent-12345', metadata: METADATA });
    const listing = await getListingById('rent', '12345');

    expect(listing?.externalId).toBe('12345');
    expect(listing?.priceLabel).toBe('PKR 2.5 Lakh');
    const firstCall = (spy.mock.calls[0] as unknown[] | undefined)?.[0] as string | undefined;
    expect(firstCall).toContain('/documents/rent-12345');
  });

  it('returns null for a document that no longer exists', async () => {
    stubFetch({ error: 'not found' }, { ok: false, status: 404 });
    await expect(getListingById('buy', '99999')).resolves.toBeNull();
  });

  it('returns null when the document carries no metadata', async () => {
    stubFetch({ id: 'rent-12345' });
    await expect(getListingById('rent', '12345')).resolves.toBeNull();
  });

  it('rejects an id containing path characters without calling the API', async () => {
    const spy = stubFetch({});
    await expect(getListingById('rent', '../../secrets')).resolves.toBeNull();
    await expect(getListingById('rent', '')).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('raises on an unexpected upstream failure rather than pretending the listing is gone', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(getListingById('rent', '12345')).rejects.toThrow(/HTTP 500/);
  });
});

describe('searchListings', () => {
  it('sends the exact filter, the ranking query, and a small keyword blend', async () => {
    const spy = stubFetch({ search_results: [{ document_metadata: METADATA }] });
    const listings = await searchListings({ purpose: 'rent', area: 'Clifton' }, 'sea facing');

    expect(listings.map((l) => l.externalId)).toEqual(['12345']);
    const init = (spy.mock.calls[0] as unknown[] | undefined)?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as {
      query: string;
      search: { metadata_filter?: string; lexical_interpolation: number; limit: number };
    };
    expect(body.query).toBe('sea facing');
    expect(body.search.metadata_filter).toBe("doc.purpose = 'rent' AND (doc.area_l3_norm = 'clifton' OR doc.area_l4_norm = 'clifton' OR doc.area_l5_norm = 'clifton')");
    expect(body.search.lexical_interpolation).toBe(0.025);
    expect(body.search.limit).toBe(40);
  });

  it('falls back to a broad query rather than sending an empty one', async () => {
    const spy = stubFetch({ search_results: [] });
    await searchListings({}, '   ');
    const init = (spy.mock.calls[0] as unknown[] | undefined)?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? '{}') as { query: string; search: Record<string, unknown> };
    expect(body.query).toBe('property in Karachi');
    expect(body.search).not.toHaveProperty('metadata_filter');
  });
});

describe('interruptTurn', () => {
  it('posts an interrupt event to the session', async () => {
    const spy = stubFetch({}, { status: 201 });
    await expect(interruptTurn('ase_1')).resolves.toBeUndefined();
    const call = spy.mock.calls[0] as unknown as [string, { body: string }];
    expect(call[0]).toContain('/sessions/ase_1/events');
    expect(call[0]).toContain('/agents/');
    expect(JSON.parse(call[1].body)).toEqual({ type: 'interrupt', stream_response: false });
  });

  it('treats a 400 as the turn having already finished, and drains its body', async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        body: { cancel },
        json: async () => ({ messages: ['Nothing to interrupt, session is not running'] }),
        text: async () => '',
      })),
    );
    await expect(interruptTurn('ase_1')).resolves.toBeUndefined();
    // Same idiom as fetchWithRetry: nobody reads this response, so release
    // the connection rather than leaving it checked out.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('raises on any other failure', async () => {
    stubFetch({}, { ok: false, status: 500 });
    await expect(interruptTurn('ase_1')).rejects.toThrow(UpstreamError);
  });
});

describe('fetchWithRetry', () => {
  /** Each handed-out response's `body.cancel`, in order, so a test can assert
   *  the ones that were set aside were drained rather than left open. */
  let cancels: ReturnType<typeof vi.fn>[] = [];

  function sequence(responses: ({ status: number; headers?: Record<string, string> } | Error)[]) {
    cancels = [];
    const spy = vi.fn(async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      const cancel = vi.fn(async () => {});
      cancels.push(cancel);
      return {
        ok: next.status < 400,
        status: next.status,
        headers: new Headers(next.headers ?? {}),
        body: { cancel },
        json: async () => ({}),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('retries a 503 and returns the eventual success', async () => {
    const spy = sequence([{ status: 503 }, { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {});
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries 429, 502 and 504 but gives up after the configured attempts', async () => {
    const spy = sequence([{ status: 429 }, { status: 502 }, { status: 504 }, { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {});
    expect(res.status).toBe(504);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a client error', async () => {
    const spy = sequence([{ status: 400 }, { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {});
    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a network error', async () => {
    const spy = sequence([new TypeError('fetch failed'), { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {});
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timeout', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const spy = sequence([timeout, { status: 200 }]);
    await expect(fetchWithRetry('https://x/y', {})).rejects.toThrow(/timeout/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drains a response it sets aside so the connection is released', async () => {
    const spy = sequence([{ status: 503 }, { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {});
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    // The 503 nobody will read; the 200 is the caller's to consume.
    expect(cancels[0]).toHaveBeenCalledTimes(1);
    expect(cancels[1]).not.toHaveBeenCalled();
  });

  it('honours a caller that retries only some statuses', async () => {
    const spy = sequence([{ status: 503 }, { status: 200 }]);
    const res = await fetchWithRetry('https://x/y', {}, { retryable: new Set([429]) });
    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('honours a caller that opts out of retrying network errors', async () => {
    const spy = sequence([new TypeError('fetch failed'), { status: 200 }]);
    await expect(fetchWithRetry('https://x/y', {}, { networkErrors: false })).rejects.toThrow(TypeError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('waits no longer than maxRetryAfterMs even if Retry-After asks for more', async () => {
    const originalCap = retryPolicy.maxRetryAfterMs;
    retryPolicy.maxRetryAfterMs = 50;
    try {
      const spy = sequence([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]);
      const started = Date.now();
      const res = await fetchWithRetry('https://x/y', {});
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
      // With baseDelayMs zeroed only the header could delay us, and it must
      // be clamped to the cap rather than honoured.
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      retryPolicy.maxRetryAfterMs = originalCap;
    }
  });
});

describe('callers use the retrying fetch', () => {
  it('searchListings survives one 503', async () => {
    const responses: unknown[] = [{ status: 503 }, { status: 200, body: { search_results: [{ document_metadata: METADATA }] } }];
    const spy = vi.fn(async () => {
      const next = responses.shift() as { status: number; body?: unknown };
      return { ok: next.status < 400, status: next.status, headers: new Headers(), json: async () => next.body, text: async () => JSON.stringify(next.body ?? {}) };
    });
    vi.stubGlobal('fetch', spy);
    const listings = await searchListings({ purpose: 'rent' }, 'x');
    expect(listings).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('createSession survives one 502', async () => {
    const responses = [{ status: 502, body: {} }, { status: 201, body: { key: 'ase_1' } }];
    const spy = vi.fn(async () => {
      const next = responses.shift()!;
      return { ok: next.status < 400, status: next.status, headers: new Headers(), json: async () => next.body, text: async () => '' };
    });
    vi.stubGlobal('fetch', spy);
    await expect(createSession('web')).resolves.toBe('ase_1');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  /** Turn responses carry a stream body, which is what streamAgentTurn returns. */
  function turns(responses: ({ status: number } | Error)[]) {
    const spy = vi.fn(async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return {
        ok: next.status < 400,
        status: next.status,
        headers: new Headers(),
        body: new ReadableStream(),
        text: async () => '',
      };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('streamAgentTurn retries a rate limit on the initial connection', async () => {
    const spy = turns([{ status: 429 }, { status: 200 }]);
    const res = await streamAgentTurn('ase_1', 'hi');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // A turn is not idempotent: a second POST would append the user's message
  // to the session again, so only a refusal that never reached the agent is
  // worth repeating.
  it('streamAgentTurn does not retry a 503', async () => {
    const spy = turns([{ status: 503 }, { status: 200 }]);
    await expect(streamAgentTurn('ase_1', 'hi')).rejects.toThrow(/HTTP 503/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('streamAgentTurn does not retry a network error', async () => {
    const spy = turns([new TypeError('fetch failed'), { status: 200 }]);
    await expect(streamAgentTurn('ase_1', 'hi')).rejects.toThrow(TypeError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('createSession asks for a seven-day idle expiry', async () => {
    const spy = stubFetch({ key: 'ase_1' }, { status: 201 });
    await expect(createSession('web')).resolves.toBe('ase_1');
    const init = (spy.mock.calls[0] as unknown[])[1] as { body: string };
    expect(JSON.parse(init.body)).toMatchObject({ name: 'web', tti_minutes: 10_080 });
  });
});
