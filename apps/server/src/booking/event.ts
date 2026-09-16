import type { BuyerDetails, Listing } from '@zameen/shared';
import { sanitizeText } from '../buyer.js';

/** Paired with BookingConfig.tzOffset. The dateTime strings already carry the
 *  offset, which is what Google actually uses; this is for display. */
export const CALENDAR_TIMEZONE = 'Asia/Karachi';

export interface GoogleEventBody {
  summary: string;
  location: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: { email: string; displayName: string }[];
  extendedProperties: { private: Record<string, string> };
  reminders: { useDefault: false; overrides: { method: string; minutes: number }[] };
}

/** Zameen's property types are plural category names; an event title reads
 *  better singular. Unmapped values are left exactly as written. */
const SINGULAR: Record<string, string> = {
  Houses: 'House',
  Flats: 'Flat',
  'Upper Portions': 'Upper Portion',
  'Lower Portions': 'Lower Portion',
  Penthouse: 'Penthouse',
};

function place(listing: Listing): string {
  const areaL4 = sanitizeText(listing.areaL4, 100);
  const areaL3 = sanitizeText(listing.areaL3, 100);
  const areaL5 = sanitizeText(listing.areaL5, 100);
  const city = sanitizeText(listing.city, 100);
  return areaL4 || areaL3 || areaL5 || city;
}

export function buildEvent(
  listing: Listing,
  buyer: BuyerDetails,
  slot: { startIso: string; endIso: string },
  timeZone: string = CALENDAR_TIMEZONE,
): GoogleEventBody {
  const propertyType = sanitizeText(listing.propertyType, 50);
  const priceLabel = sanitizeText(listing.priceLabel, 100);
  const areaPath = sanitizeText(listing.areaPath, 200);
  const city = sanitizeText(listing.city, 100);
  const url = sanitizeText(listing.url, 500);

  const type = SINGULAR[propertyType] ?? propertyType;
  const price = listing.purpose === 'rent' ? `${priceLabel} per month` : priceLabel;

  const description = [
    `Buyer: ${buyer.name} · ${buyer.email} · ${buyer.phone}`,
    `Property: ${price} · ${listing.bedrooms} bed · ${listing.areaSqft.toLocaleString('en-US')} sq ft · ${propertyType}`,
    `Where: ${areaPath || city}`,
    `Listing: ${url}`,
    '',
    'Booked through Zameen AI.',
  ].join('\n');

  return {
    summary: `Property viewing — ${listing.bedrooms} bed ${type}, ${place(listing)}`,
    location: areaPath || city,
    description,
    start: { dateTime: slot.startIso, timeZone },
    end: { dateTime: slot.endIso, timeZone },
    // Adding the buyer as an attendee is what makes Google email them an invite
    // once the event is created with sendUpdates=all.
    attendees: [{ email: buyer.email, displayName: buyer.name }],
    // Structured twin of the description. Google's UI never displays this, so
    // the description above stays the copy a human actually reads.
    extendedProperties: {
      private: {
        listingId: listing.externalId,
        purpose: listing.purpose,
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        buyerPhone: buyer.phone,
        bookedVia: 'zameen-ai-agent',
      },
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 },
      ],
    },
  };
}
