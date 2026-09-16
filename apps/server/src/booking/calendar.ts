import { GoogleError } from '../google/oauth.js';
import { tokens } from '../google/tokens.js';
import type { BusyInterval } from './availability.js';
import { bookingConfig } from './config.js';
import type { GoogleEventBody } from './event.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

async function authHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokens.get()}`,
    'Content-Type': 'application/json',
  };
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
}

/**
 * Busy windows for the whole booking window in one call.
 *
 * One request per modal session rather than one per date is what lets the
 * buyer click through all fourteen days with no further latency.
 */
export async function fetchBusy(timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]> {
  const res = await fetch(`${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: bookingConfig.calendarId }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new GoogleError(`freeBusy failed (HTTP ${res.status})`, res.status);

  const data = (await res.json().catch(() => ({}))) as FreeBusyResponse;
  const calendar = data.calendars?.[bookingConfig.calendarId];

  // A per-calendar error is reported inside a 200 response, so this is the
  // only place a wrong GOOGLE_CALENDAR_ID surfaces. Silently treating it as
  // "no busy time" would let every slot look free.
  if (calendar?.errors?.length) {
    const reasons = calendar.errors.map((e) => e.reason).join(', ');
    throw new GoogleError(`Calendar '${bookingConfig.calendarId}' is not readable: ${reasons}`, 502);
  }

  // If the calendar key is missing from the response, we cannot read it.
  if (!calendar) {
    throw new GoogleError(`freeBusy response did not include calendar '${bookingConfig.calendarId}'`, 502);
  }

  return (calendar.busy ?? [])
    .map((window) => ({ start: Date.parse(window.start), end: Date.parse(window.end) }))
    .filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end));
}

export async function insertEvent(body: GoogleEventBody): Promise<{ id: string; htmlLink: string }> {
  // sendUpdates=all is what makes Google email the invite to the attendee.
  const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(bookingConfig.calendarId)}/events?sendUpdates=all`;

  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GoogleError(`Could not create the event (HTTP ${res.status}): ${detail.slice(0, 200)}`, res.status);
  }

  const data = (await res.json().catch(() => ({}))) as { id?: string; htmlLink?: string };
  if (typeof data.id !== 'string' || data.id === '') {
    throw new GoogleError('Google returned an event creation response with no id', 502);
  }

  return { id: data.id, htmlLink: String(data.htmlLink ?? '') };
}
