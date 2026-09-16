import type { Availability, Booking, BookingRequest, BuyerDetails } from '@zameen/shared';

export interface Me {
  buyer: (BuyerDetails & { via: string }) | null;
  bookingEnabled: boolean;
}

/** Carries the status so the modal can tell a taken slot (409) from a
 *  disconnected calendar (503) from a bad field (422). */
export class BookingError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string) {
    super(message);
    this.name = 'BookingError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new BookingError(body.error ?? `Request failed (${res.status})`, res.status, body.field);
  }

  return (await res.json()) as T;
}

export const SIGN_IN_URL = '/api/auth/google';

export const getMe = () => request<Me>('/api/me');
export const getAvailability = () => request<Availability>('/api/availability');
export const signOut = () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }).then(() => undefined);

export const createBooking = (body: BookingRequest) =>
  request<{ booking: Booking }>('/api/bookings', { method: 'POST', body: JSON.stringify(body) })
    .then((r) => r.booking);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parsed as UTC and read with UTC getters, so the viewer's own timezone
 *  cannot shift the date by a day. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The Karachi wall-clock time, taken from the ISO string itself.
 *
 * Deliberately not `new Date(...)`: that would render in the viewer's own
 * timezone, so an overseas buyer would be shown a time the estate agent is
 * not expecting them.
 */
export function slotLabel(startIso: string): string {
  const hour24 = Number(startIso.slice(11, 13));
  const minutes = startIso.slice(14, 16);
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

export function slotRangeLabel(startIso: string, endIso: string): string {
  return `${dayLabel(startIso.slice(0, 10))}, ${slotLabel(startIso)} – ${slotLabel(endIso)}`;
}
