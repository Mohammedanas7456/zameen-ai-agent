import { describe, it, expect } from 'vitest';
import type { Listing } from '@zameen/shared';
import {
  checkGrounding,
  compareFilters,
  evaluateTurn,
  extractPrices,
  findAreaMentions,
} from './check.js';

const LISTING = {
  externalId: '1', title: 'Well kept 3 bed flat', description: '', url: 'https://www.zameen.com/Property/x.html',
  purpose: 'rent', propertyType: 'Flats', bedrooms: 3, bathrooms: 2, pricePkr: 125_000,
  priceLabel: 'PKR 1.25 Lakh', rentFrequency: null, areaSqft: 1269, areaSqyd: 141,
  city: 'Karachi', areaL3: 'Clifton', areaL4: 'Clifton - Block 1', areaL5: 'Cliftonia',
  areaPath: 'Clifton > Clifton - Block 1 > Cliftonia',
  locationSlug: '', floor: null, floorNum: null, floorRaw: null, lat: null, lng: null,
  isVerified: true, agency: null, photoCount: 0, coverPhoto: null, listedAt: 0,
  sourceUrl: '', firstSeenAt: 0, lastSeenAt: 0,
} satisfies Listing;

const listingAt = (pricePkr: number, areaPath = LISTING.areaPath): Listing => ({ ...LISTING, pricePkr, areaPath });

const AREAS = ['Clifton', 'Clifton - Block 1', 'DHA Phase 6', 'DHA Defence', 'North Nazimabad', 'Gulshan-e-Iqbal', 'Gulshan-e-Iqbal Town'];

describe('extractPrices', () => {
  it('reads lakh and crore with a PKR prefix or without', () => {
    expect(extractPrices('PKR 1.25 lakh and 2.5 crore')).toEqual([125_000, 25_000_000]);
  });

  it('applies a trailing unit to both ends of a range', () => {
    expect(extractPrices('rents run 1.25–1.6 lakh here')).toEqual([125_000, 160_000]);
  });

  it('keeps a comma-formatted first number in a mixed range as rupees', () => {
    expect(extractPrices('from 75,000–1.65 lakh')).toEqual([75_000, 165_000]);
  });

  it('reads comma-formatted rupee amounts and k', () => {
    expect(extractPrices('around 85k, or PKR 75,000, or Rs 45,000')).toEqual([85_000, 75_000, 45_000]);
  });

  it('ignores sizes, counts, ordinals and bare small numbers', () => {
    expect(extractPrices('a 2-bed, 1,269 sq ft flat on the 5th floor; 40 matches; 3 bedrooms in 2026')).toEqual([]);
  });

  it('ignores a difference, not a price', () => {
    expect(extractPrices('roughly 40–50k less per month than Clifton')).toEqual([]);
  });

  it('keeps a per-month price', () => {
    expect(extractPrices('1.6 lakh/month for the verified one')).toEqual([160_000]);
  });

  it('deduplicates', () => {
    expect(extractPrices('1.5 lakh … again 1.5 lakh')).toEqual([150_000]);
  });

  it('reads thousand as a unit', () => {
    expect(extractPrices('33 rentals matched, from PKR 75 thousand to 1.6 lakh.')).toEqual([75_000, 160_000]);
    expect(extractPrices('both 648 sq ft flats at PKR 20 thousand')).toEqual([20_000]);
    expect(extractPrices('a 7th-floor 3-bed flat in Block F at PKR 95 thousand')).toEqual([95_000]);
  });

  it('classifies a unit-less range by the size word after its second number', () => {
    expect(extractPrices('3-bed flats around 1,500–1,600 sq ft at PKR 75 thousand')).toEqual([75_000]);
    expect(extractPrices('a brand-new 1,250-sq-ft flat at PKR 73 thousand')).toEqual([73_000]);
    expect(extractPrices('1,250 square feet')).toEqual([]);
    expect(extractPrices('from 75,000–1.65 lakh')).toEqual([75_000, 165_000]);
  });
});

describe('findAreaMentions', () => {
  it('finds known names as whole phrases, case-insensitively', () => {
    expect(findAreaMentions('Clifton is pricier than dha phase 6.', AREAS)).toEqual(['DHA Phase 6', 'Clifton']);
  });

  it('does not match inside a longer word', () => {
    expect(findAreaMentions('Cliftonia tower', AREAS)).toEqual([]);
  });

  it('returns each name once', () => {
    expect(findAreaMentions('Clifton, then Clifton again', AREAS)).toEqual(['Clifton']);
  });

  it('matches a hyphenated area against a spaced mention, and vice versa', () => {
    expect(findAreaMentions('the 2-bed lounge flat in Gulistan-e-Jauhar Block 14', ['Gulistan-e-Jauhar', 'Gulistan-e-Jauhar - Block 14'])).toContain(
      'Gulistan-e-Jauhar - Block 14',
    );
    const found = findAreaMentions('Clifton Block 9 has a verified 2-bed', ['Clifton', 'Clifton - Block 9', 'Clifton Block 9']);
    expect(found).toHaveLength(new Set(found).size);
  });
});

describe('compareFilters', () => {
  it('is clean when the actual filters cover the expected ones exactly', () => {
    expect(
      compareFilters({ purpose: 'rent', area: 'Clifton', minBedrooms: 2 }, { purpose: 'rent', area: 'clifton', minBedrooms: 2 }),
    ).toEqual({ missing: [], different: [], extra: [] });
  });

  it('reports missing, different and extra keys', () => {
    expect(
      compareFilters(
        { purpose: 'rent', area: 'Clifton', minBedrooms: 2, propertyType: 'Flats' },
        { purpose: 'rent', minBedrooms: 3, floor: 'ground' },
      ),
    ).toEqual({
      missing: ['area', 'propertyType'],
      different: ['minBedrooms: expected 2, got 3'],
      extra: ['floor: ground'],
    });
  });

  it('treats area and areas as one set', () => {
    expect(
      compareFilters({ areas: ['North Nazimabad', 'Clifton'] }, { area: 'clifton', areas: ['north nazimabad'] }),
    ).toEqual({ missing: [], different: [], extra: [] });
    expect(compareFilters({ area: 'Clifton' }, { areas: ['Clifton', 'DHA Phase 6'] }).different).toEqual([
      'area: expected clifton, got clifton or dha phase 6',
    ]);
  });
});

describe('checkGrounding', () => {
  it('accepts prices within tolerance of a listing and areas in a listing path', () => {
    const result = checkGrounding({
      narration: 'The Clifton flat is about PKR 1.3 lakh in Clifton - Block 1.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('flags a price no listing has and an area no listing is in', () => {
    const result = checkGrounding({
      narration: 'There is a bargain at 90,000 in DHA Phase 6.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [90_000], ungroundedAreas: ['DHA Phase 6'] });
  });

  it('allows prices and areas the user themselves mentioned', () => {
    const result = checkGrounding({
      narration: 'Nothing under 50,000 in DHA Phase 6, but Clifton has one at 1.25 lakh.',
      listings: [listingAt(125_000)],
      knownAreas: AREAS,
      allowedText: 'anything under 50,000 in DHA Phase 6?',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('grounds an area whose spelling in the path differs only by separators', () => {
    const result = checkGrounding({
      narration: 'the 2-bed lounge flat in Gulistan-e-Jauhar Block 14',
      listings: [listingAt(125_000, 'Gulistan-e-Jauhar > Gulistan-e-Jauhar - Block 14')],
      knownAreas: ['Gulistan-e-Jauhar', 'Gulistan-e-Jauhar - Block 14'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual([]);
  });

  it('grounds an area written with spaces against a path written with hyphens', () => {
    const result = checkGrounding({
      narration: 'Clifton Block 9 has a verified 2-bed',
      listings: [listingAt(125_000, 'Clifton > Clifton - Block 9')],
      knownAreas: ['Clifton', 'Clifton - Block 9', 'Clifton Block 9'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual([]);
  });

  it('grounds a mention that only the listing title names, not the path', () => {
    const result = checkGrounding({
      narration: 'in Khayaban-e-Shahbaz',
      listings: [
        { ...listingAt(125_000, 'DHA Defence > DHA Phase 6 > Bukhari Commercial'), title: '2 Bed Flat For Rent In Khayaban-e-Shahbaz' },
      ],
      knownAreas: ['Khayaban-e-Shahbaz', 'DHA Phase 6'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual([]);
  });

  it('still flags a sub-area neither the path nor the title names, even when its parent is grounded', () => {
    const result = checkGrounding({
      narration: 'a bargain in Clifton Block 2',
      listings: [{ ...listingAt(125_000, 'Clifton > Clifton - Block 1'), title: 'Flat in Cliftonia' }],
      knownAreas: ['Clifton', 'Clifton - Block 2'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual(['Clifton - Block 2']);
  });
});

describe('evaluateTurn', () => {
  const observed = (over: Partial<Parameters<typeof evaluateTurn>[1]>) => ({
    userMessage: 'rent a 2 bed flat in Clifton',
    searches: [{ purpose: 'rent' as const, area: 'clifton', minBedrooms: 2 }],
    listings: [listingAt(125_000)],
    narration: 'One Clifton flat at 1.25 lakh.',
    errors: [],
    ...over,
  });

  it('passes a grounded turn whose search matches', () => {
    expect(evaluateTurn({ searches: [{ purpose: 'rent', area: 'Clifton', minBedrooms: 2 }] }, observed({}), AREAS)).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails on the wrong number of searches', () => {
    const v = evaluateTurn({ searches: [] }, observed({}), AREAS);
    expect(v.failures).toEqual(['expected 0 search(es), got 1']);
  });

  it('fails on a missing filter, warns on an extra one', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton', propertyType: 'Flats' }] },
      observed({ searches: [{ purpose: 'rent', area: 'clifton', minBedrooms: 2 }] }),
      AREAS,
    );
    expect(v.failures).toEqual(['search 1: missing propertyType']);
    expect(v.warnings).toEqual(['search 1: extra minBedrooms: 2']);
  });

  it('fails on an unexpected area — the prompt forbids substituting one', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'buy', propertyType: 'Houses', minBedrooms: 4 }] },
      observed({ searches: [{ purpose: 'buy', area: 'clifton', propertyType: 'houses', minBedrooms: 4 }] }),
      AREAS,
    );
    expect(v.failures).toEqual(['search 1: unexpected area: clifton']);
    expect(v.warnings).toEqual([]);
  });

  it('fails on an ungrounded price, an error event, and a narration mismatch', () => {
    // area: 'Clifton' matches the fixture's default search so this test's own
    // failures — not the unrelated "unexpected area" check F4 added — are
    // the only ones exercised here.
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }], narration: /DHA/ },
      observed({ narration: 'A flat at 2 lakh.', errors: ['Search failed: HTTP 503'] }),
      AREAS,
    );
    expect(v.failures).toEqual([
      'error event: Search failed: HTTP 503',
      'narration does not match /DHA/',
      'price not in results: PKR 200,000',
    ]);
  });

  it('skips grounding when told to, and when there were no listings', () => {
    expect(evaluateTurn({ skipGrounding: true }, observed({ narration: 'Try 3 lakh.' }), AREAS).failures).toEqual([]);
    expect(evaluateTurn({}, observed({ listings: [], narration: 'Nothing; try 3 lakh.' }), AREAS).failures).toEqual([]);
  });

  it('fails an empty narration', () => {
    expect(evaluateTurn({}, observed({ narration: '   ' }), AREAS).failures).toEqual(['empty narration']);
  });
});
