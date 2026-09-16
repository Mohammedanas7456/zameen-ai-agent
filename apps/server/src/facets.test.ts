import { describe, it, expect } from 'vitest';
import { aggregateFacets } from './facets.js';

const doc = (over: Record<string, unknown> = {}) => ({
  purpose: 'rent',
  property_type: 'Flats',
  bedrooms: 3,
  price_pkr: 200_000,
  area_l3: 'DHA Defence',
  area_l4: 'DHA Phase 6',
  area_l5: '',
  floor: 'unknown',
  ...over,
});

describe('aggregateFacets', () => {
  it('returns an empty shape for no documents rather than throwing', () => {
    const f = aggregateFacets([]);
    expect(f.total).toBe(0);
    expect(f.areas).toEqual([]);
    expect(f.bedrooms).toEqual({ min: 0, max: 0 });
    expect(f.price.rent).toEqual({ min: 0, max: 0 });
  });

  it('counts an area at every level it appears', () => {
    const f = aggregateFacets([doc()]);
    expect(f.areas).toEqual([
      { name: 'DHA Defence', level: 3, count: 1 },
      { name: 'DHA Phase 6', level: 4, count: 1 },
    ]);
  });

  it('skips empty area levels', () => {
    expect(aggregateFacets([doc({ area_l4: '', area_l5: '' })]).areas).toEqual([
      { name: 'DHA Defence', level: 3, count: 1 },
    ]);
  });

  it('orders areas by count, then name', () => {
    const f = aggregateFacets([
      doc({ area_l3: 'Clifton', area_l4: '' }),
      doc({ area_l3: 'DHA Defence', area_l4: '' }),
      doc({ area_l3: 'DHA Defence', area_l4: '' }),
    ]);
    expect(f.areas.map((a) => a.name)).toEqual(['DHA Defence', 'Clifton']);
  });

  it('separates rent and buy price ranges', () => {
    const f = aggregateFacets([
      doc({ purpose: 'rent', price_pkr: 50_000 }),
      doc({ purpose: 'rent', price_pkr: 500_000 }),
      doc({ purpose: 'buy', price_pkr: 20_000_000 }),
    ]);
    expect(f.price.rent).toEqual({ min: 50_000, max: 500_000 });
    expect(f.price.buy).toEqual({ min: 20_000_000, max: 20_000_000 });
  });

  it('ignores zero prices when computing a range', () => {
    const f = aggregateFacets([doc({ price_pkr: 0 }), doc({ price_pkr: 150_000 })]);
    expect(f.price.rent).toEqual({ min: 150_000, max: 150_000 });
  });

  it('computes the bedroom range, ignoring zeroes', () => {
    const f = aggregateFacets([doc({ bedrooms: 0 }), doc({ bedrooms: 2 }), doc({ bedrooms: 7 })]);
    expect(f.bedrooms).toEqual({ min: 2, max: 7 });
  });

  it('counts purposes and property types', () => {
    const f = aggregateFacets([
      doc({ purpose: 'rent', property_type: 'Flats' }),
      doc({ purpose: 'buy', property_type: 'Houses' }),
      doc({ purpose: 'buy', property_type: 'Houses' }),
    ]);
    expect(f.purposes).toEqual([
      { name: 'buy', count: 2 },
      { name: 'rent', count: 1 },
    ]);
    expect(f.propertyTypes[0]).toEqual({ name: 'Houses', count: 2 });
  });

  it('omits the "unknown" floor sentinel from the floor facet', () => {
    const f = aggregateFacets([doc({ floor: 'unknown' }), doc({ floor: 'ground' })]);
    expect(f.floors).toEqual([{ name: 'ground', count: 1 }]);
  });

  it('coerces string-typed numbers coming back from metadata', () => {
    const f = aggregateFacets([doc({ bedrooms: '4', price_pkr: '250000' })]);
    expect(f.bedrooms).toEqual({ min: 4, max: 4 });
    expect(f.price.rent).toEqual({ min: 250_000, max: 250_000 });
  });

  it('tolerates documents missing fields entirely', () => {
    const f = aggregateFacets([{}, doc()]);
    expect(f.total).toBe(2);
    expect(f.areas).toHaveLength(2);
  });
});
