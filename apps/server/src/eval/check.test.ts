import { describe, it, expect } from 'vitest';
import type { Listing } from '@zameen/shared';
import {
  checkGrounding,
  claimSentences,
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

  it('still vetoes a size or count word after a thousand-scale number', () => {
    expect(extractPrices('a 2 thousand sq ft house at PKR 3 lakh')).toEqual([300_000]);
    expect(extractPrices('around 3 thousand people')).toEqual([]);
    expect(extractPrices('PKR 75 thousand')).toEqual([75_000]);
    expect(extractPrices('from PKR 75 thousand to 1.6 lakh')).toEqual([75_000, 160_000]);
  });

  it('reads a bare thousand-scale price stated after a money preposition', () => {
    expect(extractPrices('a 3-bed in DHA Phase 6 at 95 thousand')).toEqual([95_000]);
    expect(extractPrices('asking for 90 thousand')).toEqual([90_000]);
    expect(extractPrices('around 3 thousand people')).toEqual([]);
  });

  it('ignores a threshold the reply is filtering by, not a price anything is listed at', () => {
    expect(extractPrices('everything under 2 lakh here is a 2-bed')).toEqual([]);
    expect(extractPrices('nothing below PKR 90,000, and none above 3 crore')).toEqual([]);
    expect(extractPrices('up to 1.5 lakh, at least 75,000, within 2 crore')).toEqual([]);
    expect(extractPrices('PKR 1.25 lakh')).toEqual([125_000]);
    expect(extractPrices('a bargain at 90,000')).toEqual([90_000]);
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

  it('does not let a generic short name match inside a longer name it is part of', () => {
    expect(findAreaMentions('nearby PECHS Block 6 today', ['Block 6', 'PECHS Block 6', 'PECHS'])).toEqual(['PECHS Block 6']);
  });

  it('still finds a short name elsewhere once the long match has claimed its own span', () => {
    expect(findAreaMentions('PECHS Block 6 and also Block 5', ['Block 5', 'Block 6', 'PECHS Block 6'])).toEqual([
      'PECHS Block 6',
      'Block 5',
    ]);
  });

  it('claims every occurrence of a long name, so a short one inside the second is suppressed too', () => {
    expect(
      findAreaMentions('Two in PECHS Block 6; the PECHS Block 6 one is verified.', ['Block 6', 'PECHS Block 6', 'PECHS']),
    ).toEqual(['PECHS Block 6']);
  });
});

describe('claimSentences', () => {
  it('drops an offer phrased as a statement, with no question mark to give it away', () => {
    expect(claimSentences('I can also pull up DHA Phase 6 if you like.')).toBe('');
    expect(claimSentences('I could widen the search.')).toBe('');
    expect(claimSentences('Let me know which suits you.')).toBe('');
  });

  it('keeps the claim an offer is tacked onto after a dash or a semicolon', () => {
    expect(claimSentences("There's also a 3-bed at 95 thousand — want me to pull it up?")).toBe(
      "There's also a 3-bed at 95 thousand",
    );
    expect(claimSentences('A 2-bed at 3 lakh; want me to widen?')).toBe('A 2-bed at 3 lakh;');
  });

  it('drops a bare question, which is an offer even without a marker', () => {
    expect(claimSentences('Any interest in DHA Phase 6?')).toBe('');
  });

  it('keeps a plain statement whole', () => {
    expect(claimSentences('Clifton has one at 1.25 lakh.')).toBe('Clifton has one at 1.25 lakh.');
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

  it('ignores the price and area in a trailing offer of a next step', () => {
    const result = checkGrounding({
      narration:
        '1 match in PECHS at PKR 1.4 lakh in PECHS Block 2. Want me to also check nearby PECHS Block 6 or widen beyond ground floor?',
      listings: [listingAt(140_000, 'Jamshed Town > PECHS > PECHS Block 2')],
      knownAreas: ['PECHS', 'PECHS Block 2', 'PECHS Block 6'],
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('still flags a claim made in a statement even when an offer follows it', () => {
    const result = checkGrounding({
      narration: 'There is a 3-bed in PECHS Block 6 at 1.4 lakh. Want me to widen?',
      listings: [listingAt(140_000, 'Jamshed Town > PECHS > PECHS Block 2')],
      knownAreas: ['PECHS', 'PECHS Block 2', 'PECHS Block 6'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual(['PECHS Block 6']);
  });

  it('exempts only the question price, not the statement price ahead of it', () => {
    const result = checkGrounding({
      // "Nothing under 1 lakh" would say the same thing, but a price after
      // "under" is a threshold the reply is filtering by and no longer
      // extracted at all (see extractPrices), which would prove nothing here.
      narration: 'The cheapest is at 1 lakh. Want me to try under 1.5 lakh?',
      listings: [listingAt(140_000)],
      knownAreas: AREAS,
      allowedText: '',
    });
    expect(result.ungroundedPrices).toEqual([100_000]);
  });

  it('flags a claim an offer is tacked onto after a dash', () => {
    const result = checkGrounding({
      narration: "There's also a 3-bed in DHA Phase 6 at 95 thousand — want me to pull it up?",
      listings: [listingAt(118_000), listingAt(145_000), listingAt(175_000)],
      knownAreas: ['Clifton', 'DHA Phase 6'],
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [95_000], ungroundedAreas: ['DHA Phase 6'] });
  });

  it('flags a claim an offer is tacked onto after a semicolon', () => {
    const result = checkGrounding({
      narration: 'A 2-bed in DHA Phase 6 at 3 lakh; want me to widen?',
      listings: [listingAt(118_000), listingAt(145_000), listingAt(175_000)],
      knownAreas: ['Clifton', 'DHA Phase 6'],
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [300_000], ungroundedAreas: ['DHA Phase 6'] });
  });

  it('flags nothing in a bare question that floats an area', () => {
    const result = checkGrounding({
      narration: 'Any interest in DHA Phase 6?',
      listings: [listingAt(118_000)],
      knownAreas: ['Clifton', 'DHA Phase 6'],
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('flags nothing in an offer to look somewhere else, however it is phrased', () => {
    const result = checkGrounding({
      narration: 'Clifton has one at 1.18 lakh. I can also pull up DHA Phase 6 if you like.',
      listings: [listingAt(118_000)],
      knownAreas: ['Clifton', 'DHA Phase 6'],
      allowedText: '',
    });
    expect(result).toEqual({ ungroundedPrices: [], ungroundedAreas: [] });
  });

  it('does not let a title ground an area that is merely a substring of one of its words', () => {
    const result = checkGrounding({
      narration: 'in Clifton',
      listings: [{ ...listingAt(125_000, 'Karachi'), title: 'Cliftonia Tower' }],
      knownAreas: ['Clifton'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual(['Clifton']);
  });

  it('grounds an area the title names as a whole phrase', () => {
    const result = checkGrounding({
      narration: 'in Clifton',
      listings: [{ ...listingAt(125_000, 'Karachi'), title: '2 Bed Flat For Rent In Clifton Block 9' }],
      knownAreas: ['Clifton'],
      allowedText: '',
    });
    expect(result.ungroundedAreas).toEqual([]);
  });
});

describe('evaluateTurn', () => {
  const observed = (over: Partial<Parameters<typeof evaluateTurn>[1]>) => ({
    userMessage: 'rent a 2 bed flat in Clifton',
    allowedText: 'rent a 2 bed flat in Clifton',
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

  it('grades against the listings the agent was handed', () => {
    // The runner passes only the listings the agent was shown, so a price from
    // the ninth result is ungrounded exactly as an invented one would be.
    const v = evaluateTurn({}, observed({ narration: 'One at 2.9 lakh.' }), AREAS);
    expect(v.failures).toEqual(['price not in results: PKR 290,000']);
  });

  it('grounds a price and an area the user named in an earlier turn', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }] },
      observed({
        userMessage: 'and 3 bedrooms',
        allowedText: 'rent in DHA Phase 6\nand 3 bedrooms',
        searches: [{ purpose: 'rent', area: 'clifton' }],
        narration: 'Nothing in DHA Phase 6 yet, but Clifton has one at 1.25 lakh.',
      }),
      AREAS,
    );
    expect(v.failures).toEqual([]);
  });

  it('grounds a reply that answers the budget the user set two turns ago', () => {
    const v = evaluateTurn(
      {},
      observed({
        userMessage: 'any area',
        allowedText: 'buy a house under 2.5 crore\nany area',
        listings: [listingAt(20_000_000, 'Clifton')],
        narration: 'Nothing under 2.5 crore, but Clifton has one at 2 crore.',
      }),
      AREAS,
    );
    expect(v.failures).toEqual([]);
  });

  it('allows an extra search when the case says so, and warns about it', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }], allowExtraSearches: true },
      observed({
        searches: [
          { purpose: 'rent', area: 'clifton' },
          { purpose: 'rent', area: 'clifton', minBedrooms: 2 },
        ],
      }),
      AREAS,
    );
    expect(v.failures).toEqual([]);
    expect(v.warnings).toEqual(['search 2: unexpected extra search']);
  });

  it('still fails a missing search when extra ones are allowed', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }], allowExtraSearches: true },
      observed({ searches: [] }),
      AREAS,
    );
    expect(v.failures).toEqual(['expected at least 1 search(es), got 0']);
  });

  it('fails a forbidden filter and an invented budget, and still only warns about an extra bedroom count', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }], forbidden: ['floor'] },
      observed({ searches: [{ purpose: 'rent', area: 'clifton', floor: 'ground', maxPrice: 200_000, minBedrooms: 2 }] }),
      AREAS,
    );
    expect(v.failures).toEqual([
      'search 1: forbidden floor: ground',
      'search 1: unexpected budget: maxPrice: 200000',
    ]);
    expect(v.warnings).toEqual(['search 1: extra floor: ground', 'search 1: extra minBedrooms: 2']);
  });

  it('fails a fixture reply that invents a listing, a price and an area', () => {
    const v = evaluateTurn(
      { searches: [{ purpose: 'rent', area: 'Clifton' }] },
      observed({
        searches: [{ purpose: 'rent', area: 'clifton' }],
        listings: [listingAt(125_000, 'Clifton > Clifton - Block 1')],
        narration:
          "Clifton Block 1 has one at 1.25 lakh. There's also a 4-bed in DHA Phase 6 at 95 thousand — want me to pull it up?",
      }),
      AREAS,
    );
    expect(v.failures).toEqual([
      'price not in results: PKR 95,000',
      'area not in results: DHA Phase 6',
    ]);
  });
});
