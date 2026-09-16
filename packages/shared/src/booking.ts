import type { Purpose } from './types.js';

/** The three fields that identify a buyer on a viewing. */
export interface BuyerDetails {
  name: string;
  email: string;
  phone: string;
}

/** One bookable slot. Times carry an explicit +05:00 offset, never local time. */
export interface Slot {
  startIso: string;
  endIso: string;
  available: boolean;
}

export interface AvailabilityDay {
  /** YYYY-MM-DD as it reads in Karachi. */
  date: string;
  /** 0 = Sunday, matching Date#getUTCDay. */
  weekday: number;
  /** False on a closed day; `slots` is then empty. */
  open: boolean;
  slots: Slot[];
}

export interface Availability {
  tz: string;
  slotMinutes: number;
  days: AvailabilityDay[];
}

/** What the browser posts. The listing itself is deliberately NOT included —
 *  the server re-reads it from the corpus so the client cannot dictate what
 *  lands in the estate agent's calendar. */
export interface BookingRequest {
  purpose: Purpose;
  externalId: string;
  startIso: string;
  buyer: BuyerDetails;
}

export interface Booking {
  eventId: string;
  htmlLink: string;
  startIso: string;
  endIso: string;
  listingTitle: string;
  buyerEmail: string;
}
