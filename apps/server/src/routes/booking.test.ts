import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Listing } from '@zameen/shared';

// routes/booking.ts reaches config.ts through routes/auth.ts, and config.ts
// calls required('VECTARA_API_KEY') at import time.
process.env['VECTARA_API_KEY'] ??= 'test-key';

const fetchBusy = vi.fn();
const insertEvent = vi.fn();
const getListingById = vi.fn();

vi.mock('../booking/calendar.js', () => ({
  fetchBusy: (...a: unknown[]) => fetchBusy(...a),
  insertEvent: (...a: unknown[]) => insertEvent(...a),
}));

// Mocked outright rather than with importActual: the real module imports
// config.ts, and the route only needs these two exports.
vi.mock('../vectara.js', () => ({
  getListingById: (...a: unknown[]) => getListingById(...a),
  UpstreamError: class UpstreamError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));

vi.mock('../google/tokens.js', () => ({
  isBookingEnabled: () => true,
  tokens: { get: async () => 'access-token' },
}));

const { mountBookingRoutes } = await import('./booking.js');
const { CalendarDisconnectedError, GoogleError } = await import('../google/oauth.js');

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  mountBookingRoutes(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const LISTING = {
  externalId: '12345', title: '3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 250_000,
  priceLabel: 'PKR 2.5 Lakh', rentFrequency: 'monthly', areaSqft: 1800, areaSqyd: 200,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Karachi > Clifton',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

const BUYER = { name: 'Asad Khan', email: 'asad@example.com', phone: '0300 1234567' };

/** The first available slot in the live window, so tests never go stale.
 *
 * Node's global fetch types (undici-types, not the DOM lib) type
 * Response#json() as Promise<unknown>, so reading a field back out needs a
 * cast — see the same note in routes/auth.test.ts. */
async function firstSlot(base: string): Promise<string> {
  fetchBusy.mockResolvedValueOnce([]);
  const body = (await (await fetch(`${base}/api/availability`)).json()) as {
    days: { slots: { startIso: string; available: boolean }[] }[];
  };
  return body.days.flatMap((d: { slots: { startIso: string; available: boolean }[] }) => d.slots)
    .find((s: { available: boolean }) => s.available)!.startIso;
}

beforeEach(() => {
  fetchBusy.mockReset();
  insertEvent.mockReset();
  getListingById.mockReset();
});

describe('GET /api/availability', () => {
  it('returns the whole window from a single freeBusy call', async () => {
    fetchBusy.mockResolvedValueOnce([]);
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/availability`);
      const body = (await res.json()) as { tz: string; slotMinutes: number; days: unknown[] };
      expect(res.status).toBe(200);
      expect(body.tz).toBe('Asia/Karachi');
      expect(body.slotMinutes).toBe(45);
      expect(body.days).toHaveLength(14);
      expect(fetchBusy).toHaveBeenCalledTimes(1);
    });
  });

  it('reports a disconnected calendar as 503, not a generic failure', async () => {
    fetchBusy.mockRejectedValueOnce(new CalendarDisconnectedError());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/availability`);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('connect:calendar');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports any other Google failure as 502', async () => {
    fetchBusy.mockRejectedValueOnce(new GoogleError('boom', 500));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        expect((await fetch(`${base}/api/availability`)).status).toBe(502);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a 401 from Google as a reconnect condition, not a retry one', async () => {
    fetchBusy.mockRejectedValueOnce(new GoogleError('freeBusy failed (HTTP 401): invalid_credentials', 401));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/availability`);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('connect:calendar');
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a 403 from Google as a reconnect condition, not a retry one', async () => {
    // The exact failure a real operator hit during live testing: a token
    // scoped for calendar.events alone gets 403 insufficientPermissions the
    // moment freeBusy is called, which means "reconnect", not "try again".
    fetchBusy.mockRejectedValueOnce(new GoogleError('freeBusy failed (HTTP 403): insufficientPermissions', 403));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/availability`);
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toContain('connect:calendar');
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /api/bookings', () => {
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('creates the event and returns the booking', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'evt_1', htmlLink: 'https://calendar.google.com/e/1' });

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { booking: unknown }).booking).toMatchObject({
        eventId: 'evt_1', startIso, listingTitle: '3 bed flat', buyerEmail: 'asad@example.com',
      });
    });
  });

  it('remembers the buyer so their next booking is pre-filled', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.headers.get('set-cookie')).toContain('zameen_buyer=');
    });
  });

  it('normalises the phone number before it reaches the calendar', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      const event = insertEvent.mock.calls[0]![0] as { description: string };
      expect(event.description).toContain('+923001234567');
    });
  });

  it('ignores a listing payload sent by the client and uses the corpus copy', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([]);
      insertEvent.mockResolvedValueOnce({ id: 'e', htmlLink: 'l' });

      await post(base, {
        purpose: 'rent', externalId: '12345', startIso, buyer: BUYER,
        listing: { title: 'CALL 0300-EVIL NOW', url: 'https://evil.example' },
      });

      const event = insertEvent.mock.calls[0]![0] as { summary: string; description: string };
      expect(event.summary).not.toContain('EVIL');
      expect(event.description).not.toContain('evil.example');
      expect(event.description).toContain('https://www.zameen.com/Property/x.html');
    });
  });

  it('rejects an invalid phone number with 422 and names the field', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      const res = await post(base, {
        purpose: 'rent', externalId: '12345', startIso, buyer: { ...BUYER, phone: 'call me' },
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { field: string }).field).toBe('phone');
      expect(insertEvent).not.toHaveBeenCalled();
    });
  });

  it('rejects a time that is not one of the offered slots', async () => {
    await withServer(async (base) => {
      const res = await post(base, {
        purpose: 'rent', externalId: '12345', startIso: '2030-01-01T03:17:00+05:00', buyer: BUYER,
      });
      expect(res.status).toBe(409);
    });
  });

  it('returns 409 when the slot was taken between loading and submitting', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(LISTING);
      fetchBusy.mockResolvedValueOnce([
        { start: Date.parse(startIso) - 60_000, end: Date.parse(startIso) + 60_000 },
      ]);

      const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
      expect(res.status).toBe(409);
      expect(insertEvent).not.toHaveBeenCalled();
    });
  });

  it('returns 404 when the listing has left the corpus', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockResolvedValueOnce(null);
      const res = await post(base, { purpose: 'rent', externalId: '99999', startIso, buyer: BUYER });
      expect(res.status).toBe(404);
    });
  });

  it('rejects a malformed body with 400', async () => {
    await withServer(async (base) => {
      expect((await post(base, { buyer: BUYER })).status).toBe(400);
    });
  });

  it('hides the real error message behind a generic one, but logs it server-side', async () => {
    await withServer(async (base) => {
      const startIso = await firstSlot(base);
      getListingById.mockRejectedValueOnce(new Error('ECONNRESET reading corpus shard 3'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await post(base, { purpose: 'rent', externalId: '12345', startIso, buyer: BUYER });
        expect(res.status).toBe(500);
        expect(((await res.json()) as { error: string }).error).toBe('Something went wrong. Please try again.');
        expect(spy).toHaveBeenCalledWith('Booking request failed:', expect.any(Error));
      } finally {
        spy.mockRestore();
      }
    });
  });
});
