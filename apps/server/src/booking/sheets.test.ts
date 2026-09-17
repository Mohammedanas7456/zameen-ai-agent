import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Listing, BuyerDetails } from '@zameen/shared';

// The token provider is a module singleton built from real config; stub it so
// these tests exercise only the Sheets calls.
vi.mock('../google/tokens.js', () => ({ tokens: { get: async () => 'test-access-token' } }));

const { bookingConfig } = await import('./config.js');
const { appendBookingRow } = await import('./sheets.js');
const { GoogleError } = await import('../google/oauth.js');

const LISTING = { title: '3 bed flat', purpose: 'rent' } as Listing;
const BUYER: BuyerDetails = { name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567' };
const SLOT = { startIso: '2026-09-20T11:00:00+05:00', endIso: '2026-09-20T11:45:00+05:00' };

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  bookingConfig.sheetId = '';
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

describe('appendBookingRow', () => {
  it('does nothing when no sheet is configured', async () => {
    const spy = stubFetch({});
    await appendBookingRow(LISTING, BUYER, SLOT, 'https://calendar.google.com/e/1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('appends a row to the configured sheet and range', async () => {
    bookingConfig.sheetId = 'sheet-123';
    const spy = stubFetch({});
    await appendBookingRow(LISTING, BUYER, SLOT, 'https://calendar.google.com/e/1');

    const [url, init] = (spy.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/Bookings!A%3AI:append?valueInputOption=USER_ENTERED',
    );
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-access-token');

    const body = JSON.parse(init.body as string) as { values: string[][] };
    expect(body.values).toHaveLength(1);
    expect(body.values[0]).toEqual(
      expect.arrayContaining([
        'Asad Khan',
        'asad@example.com',
        '+923001234567',
        '3 bed flat',
        'rent',
        '2026-09-20T11:00:00+05:00',
        '2026-09-20T11:45:00+05:00',
        'https://calendar.google.com/e/1',
      ]),
    );
  });

  it('fails on a non-OK response', async () => {
    bookingConfig.sheetId = 'sheet-123';
    stubFetch({ error: 'nope' }, { ok: false, status: 403 });
    await expect(appendBookingRow(LISTING, BUYER, SLOT, 'link')).rejects.toBeInstanceOf(GoogleError);
  });
});
