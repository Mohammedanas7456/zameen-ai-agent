import { describe, it, expect, vi, afterEach } from 'vitest';

// The token provider is a module singleton built from real config; stub it so
// these tests exercise only the Calendar calls.
vi.mock('../google/tokens.js', () => ({ tokens: { get: async () => 'test-access-token' } }));

const { fetchBusy, insertEvent } = await import('./calendar.js');
const { GoogleError } = await import('../google/oauth.js');

afterEach(() => vi.unstubAllGlobals());

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

describe('fetchBusy', () => {
  it('asks for the configured calendar over the requested range', async () => {
    const spy = stubFetch({ calendars: { primary: { busy: [] } } });
    await fetchBusy('2026-09-17T00:00:00+05:00', '2026-10-01T00:00:00+05:00');

    const [url, init] = (spy.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-access-token');
    expect(JSON.parse(init.body as string)).toEqual({
      timeMin: '2026-09-17T00:00:00+05:00',
      timeMax: '2026-10-01T00:00:00+05:00',
      items: [{ id: 'primary' }],
    });
  });

  it('converts busy windows to epoch milliseconds', async () => {
    stubFetch({
      calendars: { primary: { busy: [{ start: '2026-09-17T12:00:00+05:00', end: '2026-09-17T13:00:00+05:00' }] } },
    });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([
      { start: Date.parse('2026-09-17T12:00:00+05:00'), end: Date.parse('2026-09-17T13:00:00+05:00') },
    ]);
  });

  it('treats a calendar with no busy list as fully free', async () => {
    stubFetch({ calendars: { primary: {} } });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([]);
  });

  it('drops an unparseable interval rather than producing NaN bounds', async () => {
    stubFetch({ calendars: { primary: { busy: [{ start: 'not-a-date', end: 'nor-this' }] } } });
    await expect(fetchBusy('a', 'b')).resolves.toEqual([]);
  });

  it('fails loudly when Google reports the calendar is not readable', async () => {
    stubFetch({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }] } } });
    await expect(fetchBusy('a', 'b')).rejects.toBeInstanceOf(GoogleError);
  });

  it('fails on a non-OK response', async () => {
    stubFetch({ error: 'boom' }, { ok: false, status: 500 });
    await expect(fetchBusy('a', 'b')).rejects.toBeInstanceOf(GoogleError);
  });
});

describe('insertEvent', () => {
  const body = { summary: 'Property viewing' } as never;

  it('posts to the configured calendar with sendUpdates=all so the buyer is emailed', async () => {
    const spy = stubFetch({ id: 'evt_1', htmlLink: 'https://calendar.google.com/event?eid=1' });
    await expect(insertEvent(body)).resolves.toEqual({
      id: 'evt_1',
      htmlLink: 'https://calendar.google.com/event?eid=1',
    });

    const [url, init] = (spy.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all');
    expect(init.method).toBe('POST');
  });

  it('fails on a non-OK response', async () => {
    stubFetch({ error: 'nope' }, { ok: false, status: 403 });
    await expect(insertEvent(body)).rejects.toBeInstanceOf(GoogleError);
  });
});
