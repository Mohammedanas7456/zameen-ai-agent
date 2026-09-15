import { describe, it, expect } from 'vitest';
import { buildMetadataFilter } from '@zameen/shared';
import type { Listing } from '@zameen/shared';
import { criteriaToFilters, describeFilters, listingsForAgent } from './criteria.js';

describe('criteriaToFilters', () => {
  it('maps a realistic agent tool call', () => {
    expect(
      criteriaToFilters({ purpose: 'rent', area: 'DHA Phase 6', min_bedrooms: 3, max_price: 300000 }),
    ).toEqual({ purpose: 'rent', area: 'DHA Phase 6', minBedrooms: 3, maxPrice: 300000 });
  });

  it('accepts floats, because JSON turns the lambda ints into 3.0', () => {
    expect(criteriaToFilters({ purpose: 'buy', min_bedrooms: 3.0, max_price: 25000000.0 })).toEqual({
      purpose: 'buy',
      minBedrooms: 3,
      maxPrice: 25000000,
    });
  });

  it('treats 0 as "not set" for every numeric field', () => {
    expect(
      criteriaToFilters({
        purpose: 'rent',
        min_bedrooms: 0,
        max_bedrooms: 0,
        min_price: 0,
        max_price: 0,
        min_area_sqft: 0,
      }),
    ).toEqual({ purpose: 'rent' });
  });

  it('ignores blank strings', () => {
    expect(criteriaToFilters({ purpose: 'rent', area: '   ', property_type: '' })).toEqual({
      purpose: 'rent',
    });
  });

  it('drops an unknown purpose rather than guessing', () => {
    expect(criteriaToFilters({ purpose: 'lease' })).toEqual({});
  });

  it('is case insensitive on purpose and floor', () => {
    expect(criteriaToFilters({ purpose: 'RENT', floor: 'Ground' })).toEqual({
      purpose: 'rent',
      floor: 'ground',
    });
  });

  it('drops an unknown floor value', () => {
    expect(criteriaToFilters({ purpose: 'rent', floor: 'basement' })).toEqual({ purpose: 'rent' });
  });

  it('drops a negative number instead of emitting it', () => {
    expect(criteriaToFilters({ purpose: 'rent', min_bedrooms: -3 })).toEqual({ purpose: 'rent' });
  });

  it('repairs an inverted bedroom range by dropping the maximum', () => {
    expect(criteriaToFilters({ purpose: 'rent', min_bedrooms: 5, max_bedrooms: 2 })).toEqual({
      purpose: 'rent',
      minBedrooms: 5,
    });
  });

  it('repairs an inverted price range by dropping the minimum', () => {
    expect(criteriaToFilters({ purpose: 'buy', min_price: 9_000_000, max_price: 1_000_000 })).toEqual({
      purpose: 'buy',
      maxPrice: 1_000_000,
    });
  });

  it('survives a completely empty call', () => {
    expect(criteriaToFilters({})).toEqual({});
  });

  it('produces a filter the shared builder accepts', () => {
    const filters = criteriaToFilters({
      purpose: 'rent',
      area: 'Clifton',
      min_bedrooms: 2,
      max_price: 250000,
    });
    expect(buildMetadataFilter(filters)).toBe(
      "doc.purpose = 'rent' AND (doc.area_l3_norm = 'clifton' OR doc.area_l4_norm = 'clifton' " +
        "OR doc.area_l5_norm = 'clifton') AND doc.bedrooms >= 2 AND doc.price_pkr <= 250000",
    );
  });
});

describe('describeFilters', () => {
  it('reads as plain language', () => {
    expect(
      describeFilters({ purpose: 'rent', area: 'DHA Phase 6', minBedrooms: 3, maxPrice: 300000 }),
    ).toBe('for rent, in DHA Phase 6, 3+ beds, under PKR 300,000');
  });

  it('falls back when nothing is constrained', () => {
    expect(describeFilters({})).toBe('all listings');
  });
});

describe('listingsForAgent', () => {
  const listing = {
    externalId: '1', title: 'Brand New 3 Bed Apartment', description: '',
    url: 'https://www.zameen.com/x', purpose: 'rent', propertyType: 'Flats',
    bedrooms: 3, bathrooms: 3, pricePkr: 250000, priceLabel: 'PKR 2.5 Lakh',
    rentFrequency: null, areaSqft: 1800, areaSqyd: 200, city: 'Karachi',
    areaL3: 'DHA Defence', areaL4: 'DHA Phase 6', areaL5: '',
    areaPath: 'DHA Defence > DHA Phase 6', locationSlug: '',
    floor: 'ground', floorNum: 0, floorRaw: null, lat: null, lng: null,
    isVerified: true, agency: null, photoCount: 5, coverPhoto: null, listedAt: 0,
  } as Listing;

  it('says plainly when nothing matched, so the agent cannot invent results', () => {
    expect(listingsForAgent([])).toBe('No listings matched those criteria.');
  });

  it('renders the essentials of each listing', () => {
    const out = listingsForAgent([listing]);
    expect(out).toContain('1 listings matched');
    expect(out).toContain('PKR 2.5 Lakh');
    expect(out).toContain('3 bed, 3 bath, 1,800 sq ft, Flats, ground floor, verified');
    expect(out).toContain('DHA Defence > DHA Phase 6');
  });

  it('caps the list and says how many more there were', () => {
    const many = Array.from({ length: 12 }, () => listing);
    const out = listingsForAgent(many, 5);
    expect(out).toContain('12 listings matched');
    expect(out).toContain('Top 5');
    expect(out).toContain('7 further matches');
  });

  it('omits the "further matches" note when everything fits', () => {
    expect(listingsForAgent([listing], 5)).not.toContain('further matches');
  });

  it('renders a numbered floor as a real phrase, never "numbered floor"', () => {
    const out = listingsForAgent([{ ...listing, floor: 'numbered', floorNum: 3 }]);
    expect(out).toContain('floor 3');
    expect(out).not.toContain('numbered');
  });

  it('omits the floor entirely when it is unknown', () => {
    const out = listingsForAgent([{ ...listing, floor: null, floorNum: null }]);
    expect(out).not.toContain('floor');
  });

  it('describes an upper portion in words a person would use', () => {
    expect(listingsForAgent([{ ...listing, floor: 'upper', floorNum: null }])).toContain(
      'upper portion',
    );
  });
});
