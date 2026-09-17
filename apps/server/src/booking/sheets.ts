import type { BuyerDetails, Listing } from '@zameen/shared';
import { GoogleError } from '../google/oauth.js';
import { tokens } from '../google/tokens.js';
import { bookingConfig } from './config.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function authHeaders(): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await tokens.get()}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Record a booking as one row in the estate agent's tracking sheet.
 *
 * A no-op when GOOGLE_SHEET_ID isn't configured — sheet logging is an
 * optional extra on top of the calendar event and must never be a
 * precondition for booking.
 */
export async function appendBookingRow(
  listing: Listing,
  buyer: BuyerDetails,
  slot: { startIso: string; endIso: string },
  eventLink: string,
): Promise<void> {
  if (!bookingConfig.sheetId) return;

  const row = [
    new Date().toISOString(),
    buyer.name,
    buyer.email,
    buyer.phone,
    listing.title,
    listing.purpose,
    slot.startIso,
    slot.endIso,
    eventLink,
  ];

  const url = `${SHEETS_BASE}/${encodeURIComponent(bookingConfig.sheetId)}/values/${encodeURIComponent(
    bookingConfig.sheetRange,
  )}:append?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ values: [row] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GoogleError(`Could not append the booking row (HTTP ${res.status}): ${detail.slice(0, 200)}`, res.status);
  }
}
