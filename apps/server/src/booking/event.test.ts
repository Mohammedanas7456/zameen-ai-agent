import { describe, it, expect } from 'vitest';
import type { BuyerDetails, Listing } from '@zameen/shared';
import { buildEvent } from './event.js';

const LISTING: Listing = {
  externalId: '12345', title: 'Well maintained 3 bed flat with sea view',
  description: '', url: 'https://www.zameen.com/Property/clifton-12345.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2,
  pricePkr: 250_000, priceLabel: 'PKR 2.5 Lakh', rentFrequency: 'monthly',
  areaSqft: 1800, areaSqyd: 200, city: 'Karachi',
  areaL3: 'Clifton', areaL4: 'Block 2', areaL5: '', areaPath: 'Karachi > Clifton > Block 2',
  locationSlug: '', floor: 'upper', floorNum: null, floorRaw: null,
  lat: null, lng: null, isVerified: true, agency: 'Rayon Estates',
  photoCount: 8, coverPhoto: null, listedAt: 0, sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
};

const BUYER: BuyerDetails = { name: 'Asad Khan', email: 'asad@example.com', phone: '+923001234567' };
const SLOT = { startIso: '2026-09-17T15:00:00+05:00', endIso: '2026-09-17T15:45:00+05:00' };

describe('buildEvent', () => {
  const event = buildEvent(LISTING, BUYER, SLOT);

  it('names the property in the summary, with a singular property type', () => {
    expect(event.summary).toBe('Property viewing — 3 bed Flat, Block 2');
  });

  it('carries the slot times verbatim, offset included', () => {
    expect(event.start).toEqual({ dateTime: '2026-09-17T15:00:00+05:00', timeZone: 'Asia/Karachi' });
    expect(event.end).toEqual({ dateTime: '2026-09-17T15:45:00+05:00', timeZone: 'Asia/Karachi' });
  });

  it('invites the buyer, which is what makes Google email them', () => {
    expect(event.attendees).toEqual([{ email: 'asad@example.com', displayName: 'Asad Khan' }]);
  });

  it('puts all three buyer fields in the description, since Google never shows extendedProperties', () => {
    expect(event.description).toContain('Asad Khan');
    expect(event.description).toContain('asad@example.com');
    expect(event.description).toContain('+923001234567');
  });

  it('includes the listing price, size and link in the description', () => {
    expect(event.description).toContain('PKR 2.5 Lakh');
    expect(event.description).toContain('1,800 sq ft');
    expect(event.description).toContain('https://www.zameen.com/Property/clifton-12345.html');
  });

  it('marks a rental price as monthly but leaves a sale price alone', () => {
    expect(buildEvent(LISTING, BUYER, SLOT).description).toContain('PKR 2.5 Lakh per month');
    const sale = buildEvent({ ...LISTING, purpose: 'buy', priceLabel: 'PKR 4.5 Crore' }, BUYER, SLOT);
    expect(sale.description).toContain('PKR 4.5 Crore');
    expect(sale.description).not.toContain('per month');
  });

  it('mirrors the booking into extendedProperties for machine reads', () => {
    expect(event.extendedProperties.private).toEqual({
      listingId: '12345',
      purpose: 'rent',
      buyerName: 'Asad Khan',
      buyerEmail: 'asad@example.com',
      buyerPhone: '+923001234567',
      bookedVia: 'zameen-ai-agent',
    });
  });

  it('uses the area path as the location, falling back to the city', () => {
    expect(event.location).toBe('Karachi > Clifton > Block 2');
    expect(buildEvent({ ...LISTING, areaPath: '' }, BUYER, SLOT).location).toBe('Karachi');
  });

  it('falls back through the area levels when the block is unknown', () => {
    expect(buildEvent({ ...LISTING, areaL4: '' }, BUYER, SLOT).summary)
      .toBe('Property viewing — 3 bed Flat, Clifton');
  });

  it('leaves an unmapped property type as written', () => {
    expect(buildEvent({ ...LISTING, propertyType: 'Farm Houses' }, BUYER, SLOT).summary)
      .toBe('Property viewing — 3 bed Farm Houses, Block 2');
  });

  it('sets explicit reminders rather than inheriting the calendar default', () => {
    expect(event.reminders.useDefault).toBe(false);
    expect(event.reminders.overrides).toEqual([
      { method: 'popup', minutes: 60 },
      { method: 'email', minutes: 1440 },
    ]);
  });
});
