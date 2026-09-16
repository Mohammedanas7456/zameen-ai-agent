import type { BuyerDetails, Listing } from '@zameen/shared';

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
  return listing.areaL4 || listing.areaL3 || listing.areaL5 || listing.city;
}

export function buildEvent(
  listing: Listing,
  buyer: BuyerDetails,
  slot: { startIso: string; endIso: string },
  timeZone: string = CALENDAR_TIMEZONE,
): GoogleEventBody {
  const type = SINGULAR[listing.propertyType] ?? listing.propertyType;
  const price = listing.purpose === 'rent' ? `${listing.priceLabel} per month` : listing.priceLabel;

  const description = [
    `Buyer: ${buyer.name} · ${buyer.email} · ${buyer.phone}`,
    `Property: ${price} · ${listing.bedrooms} bed · ${listing.areaSqft.toLocaleString('en-US')} sq ft · ${listing.propertyType}`,
    `Where: ${listing.areaPath || listing.city}`,
    `Listing: ${listing.url}`,
    '',
    'Booked through Zameen AI.',
  ].join('\n');

  return {
    summary: `Property viewing — ${listing.bedrooms} bed ${type}, ${place(listing)}`,
    location: listing.areaPath || listing.city,
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
