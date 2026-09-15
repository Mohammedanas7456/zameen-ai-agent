import { describe, it, expect } from 'vitest';
import type { Facets } from '@zameen/shared';
import { buildMetadataFilter } from '@zameen/shared';
import { filtersFromExpression, canonicalArea } from './filters.js';

describe('filtersFromExpression', () => {
  it('returns nothing for an empty expression', () => {
    expect(filtersFromExpression('')).toEqual({});
  });

  it('reads purpose', () => {
    expect(filtersFromExpression("doc.purpose = 'rent'")).toEqual({ purpose: 'rent' });
  });

  it('reads an area from any of the three levels', () => {
    expect(filtersFromExpression("doc.area_l4_norm = 'dha phase 8'").area).toBe('dha phase 8');
    expect(filtersFromExpression("doc.area_l5_norm = 'clifton'").area).toBe('clifton');
  });

  it('reads a full realistic agent filter', () => {
    const expression =
      "doc.purpose = 'rent' AND (doc.area_l3_norm = 'dha phase 6' OR doc.area_l4_norm = 'dha phase 6') " +
      "AND doc.bedrooms >= 3 AND doc.property_type_norm = 'flats' AND doc.price_pkr <= 200000";
    expect(filtersFromExpression(expression)).toEqual({
      purpose: 'rent',
      area: 'dha phase 6',
      propertyType: 'flats',
      minBedrooms: 3,
      maxPrice: 200000,
    });
  });

  it('distinguishes a min from a max price', () => {
    const r = filtersFromExpression('doc.price_pkr >= 100000 AND doc.price_pkr <= 500000');
    expect(r).toEqual({ minPrice: 100000, maxPrice: 500000 });
  });

  it('distinguishes a min from a max bedroom count', () => {
    expect(filtersFromExpression('doc.bedrooms >= 2 AND doc.bedrooms <= 4')).toEqual({
      minBedrooms: 2,
      maxBedrooms: 4,
    });
  });

  it('reads a floor bucket', () => {
    expect(filtersFromExpression("doc.floor = 'ground'").floor).toBe('ground');
  });

  it('ignores an unrecognised floor value', () => {
    expect(filtersFromExpression("doc.floor = 'basement'").floor).toBeUndefined();
  });

  it('leaves unparseable input as an empty object rather than guessing', () => {
    expect(filtersFromExpression('some free text the model wrote')).toEqual({});
  });

  /**
   * The round trip is what keeps the sidebar honest: whatever the builder
   * emits must parse back to the same filters.
   */
  it('round-trips everything the filter builder can emit', () => {
    const original = {
      purpose: 'buy' as const,
      area: 'gulshan-e-iqbal',
      propertyType: 'houses',
      minBedrooms: 3,
      maxBedrooms: 5,
      minBathrooms: 2,
      minPrice: 5_000_000,
      maxPrice: 30_000_000,
      floor: 'ground' as const,
    };
    expect(filtersFromExpression(buildMetadataFilter(original))).toEqual(original);
  });
});

describe('canonicalArea', () => {
  const facets = {
    areas: [{ name: 'DHA Phase 6', level: 4, count: 33 }],
  } as unknown as Facets;

  it('restores canonical casing for a lowercase agent value', () => {
    expect(canonicalArea('dha phase 6', facets)).toBe('DHA Phase 6');
  });

  it('passes through an area it does not recognise', () => {
    expect(canonicalArea('Nowhere', facets)).toBe('Nowhere');
  });

  it('is safe with no facets loaded yet', () => {
    expect(canonicalArea('dha phase 6', null)).toBe('dha phase 6');
  });
});
