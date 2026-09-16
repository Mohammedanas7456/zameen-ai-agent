import type { Express, Response } from 'express';
import type { Booking, BookingRequest, Purpose } from '@zameen/shared';
import { validateBuyer } from '../buyer.js';
import { addDays, isSlotFree, offsetToMs, pktDate, slotsForWindow } from '../booking/availability.js';
import { fetchBusy, insertEvent } from '../booking/calendar.js';
import { bookingConfig } from '../booking/config.js';
import { CALENDAR_TIMEZONE, buildEvent } from '../booking/event.js';
import { CalendarDisconnectedError, GoogleError } from '../google/oauth.js';
import { isBookingEnabled } from '../google/tokens.js';
import { UpstreamError, getListingById } from '../vectara.js';
import { buyerFromRequest, setBuyerCookie } from './auth.js';

const NOT_CONNECTED =
  "The estate agent's calendar isn't connected. Run `npm run connect:calendar` to reconnect it.";

function windowBounds(now: number): { timeMin: string; timeMax: string } {
  const cfg = bookingConfig;
  const first = addDays(pktDate(now, offsetToMs(cfg.tzOffset)), cfg.leadDays);
  return {
    timeMin: `${first}T00:00:00${cfg.tzOffset}`,
    timeMax: `${addDays(first, cfg.windowDays)}T00:00:00${cfg.tzOffset}`,
  };
}

/** A dead refresh token and a flaky Google are different problems with
 *  different fixes, so they must not collapse into one status. */
function failure(res: Response, err: unknown): void {
  console.error('Booking request failed:', err);
  if (err instanceof CalendarDisconnectedError) {
    res.status(503).json({ error: NOT_CONNECTED });
  } else if (err instanceof GoogleError) {
    // A 401 or 403 means the grant itself is wrong — a stale scope, a revoked
    // token, an unshared calendar — which is a reconnect condition, same as a
    // dead refresh token. Anything else is Google being unavailable, which is
    // worth a plain retry.
    if (err.status === 401 || err.status === 403) {
      res.status(503).json({ error: NOT_CONNECTED });
    } else {
      res.status(502).json({ error: 'Google Calendar is not responding. Please try again.' });
    }
  } else if (err instanceof UpstreamError) {
    res.status(err.status).json({ error: err.message });
  } else {
    // The real message is already in the server log above; nothing further
    // identifies this route as sitting behind Google token handling.
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

export function mountBookingRoutes(app: Express): void {
  app.get('/api/availability', async (_req, res) => {
    if (!isBookingEnabled()) {
      res.status(503).json({ error: NOT_CONNECTED });
      return;
    }

    try {
      const now = Date.now();
      const { timeMin, timeMax } = windowBounds(now);
      const busy = await fetchBusy(timeMin, timeMax);
      res.json({
        tz: CALENDAR_TIMEZONE,
        slotMinutes: bookingConfig.slotMinutes,
        days: slotsForWindow(now, busy, bookingConfig),
      });
    } catch (err) {
      failure(res, err);
    }
  });

  app.post('/api/bookings', async (req, res) => {
    if (!isBookingEnabled()) {
      res.status(503).json({ error: NOT_CONNECTED });
      return;
    }

    const body = (req.body ?? {}) as Partial<BookingRequest>;
    const purpose: Purpose | null =
      body.purpose === 'rent' || body.purpose === 'buy' ? body.purpose : null;
    const externalId = typeof body.externalId === 'string' ? body.externalId : '';
    const startIso = typeof body.startIso === 'string' ? body.startIso : '';

    if (!purpose || !externalId || !startIso) {
      res.status(400).json({ error: 'purpose, externalId and startIso are required.' });
      return;
    }

    const validated = validateBuyer(body.buyer);
    if (!validated.ok) {
      res.status(422).json({ error: validated.message, field: validated.field });
      return;
    }

    try {
      const now = Date.now();

      // The requested time must be one of the slots we actually offer, not an
      // arbitrary instant the client invented.
      const slot = slotsForWindow(now, [], bookingConfig)
        .flatMap((day) => day.slots)
        .find((candidate) => candidate.startIso === startIso);

      if (!slot?.available) {
        res.status(409).json({ error: 'That time is no longer available. Please pick another slot.' });
        return;
      }

      const listing = await getListingById(purpose, externalId);
      if (!listing) {
        res.status(404).json({ error: 'That listing is no longer available.' });
        return;
      }

      // Re-check the live calendar immediately before inserting. This narrows
      // the double-booking race to milliseconds; it cannot close it, because
      // Google Calendar does not enforce slot exclusivity.
      const busy = await fetchBusy(slot.startIso, slot.endIso);
      if (!isSlotFree(Date.parse(slot.startIso), Date.parse(slot.endIso), busy)) {
        res.status(409).json({ error: 'Someone just booked that slot. Please pick another.' });
        return;
      }

      const created = await insertEvent(buildEvent(listing, validated.buyer, slot));

      // Remember the buyer — including the phone Google will never supply — so
      // a second booking is pre-filled in all three fields.
      setBuyerCookie(res, { ...validated.buyer, via: buyerFromRequest(req)?.via ?? 'manual' });

      const booking: Booking = {
        eventId: created.id,
        htmlLink: created.htmlLink,
        startIso: slot.startIso,
        endIso: slot.endIso,
        listingTitle: listing.title,
        buyerEmail: validated.buyer.email,
      };
      res.json({ booking });
    } catch (err) {
      failure(res, err);
    }
  });
}
