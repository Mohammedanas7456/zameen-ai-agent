import { describe, it, expect } from 'vitest';
import { buildMetadataFilter } from './filter.js';

describe('buildMetadataFilter', () => {
  it('returns an empty string when no filters are set', () => {
    expect(buildMetadataFilter({})).toBe('');
  });

  it('filters on purpose', () => {
    expect(buildMetadataFilter({ purpose: 'rent' })).toBe("doc.purpose = 'rent'");
  });

  it('matches an area against all three location levels, lowercased', () => {
    expect(buildMetadataFilter({ area: 'DHA Phase 8' })).toBe(
      "(doc.area_l3_norm = 'dha phase 8' OR doc.area_l4_norm = 'dha phase 8' OR doc.area_l5_norm = 'dha phase 8')",
    );
  });

  it('ORs several areas together instead of ANDing them', () => {
    expect(buildMetadataFilter({ areas: ['Gulshan-e-Iqbal', 'Johar'] })).toBe(
      "(doc.area_l3_norm = 'gulshan-e-iqbal' OR doc.area_l4_norm = 'gulshan-e-iqbal' " +
        "OR doc.area_l5_norm = 'gulshan-e-iqbal' OR doc.area_l3_norm = 'johar' " +
        "OR doc.area_l4_norm = 'johar' OR doc.area_l5_norm = 'johar')",
    );
  });

  it('combines `area` and `areas` into one OR group', () => {
    expect(buildMetadataFilter({ area: 'Clifton', areas: ['Johar'] })).toBe(
      "(doc.area_l3_norm = 'clifton' OR doc.area_l4_norm = 'clifton' OR doc.area_l5_norm = 'clifton' " +
        "OR doc.area_l3_norm = 'johar' OR doc.area_l4_norm = 'johar' OR doc.area_l5_norm = 'johar')",
    );
  });

  it('combines several filters with AND in a stable order', () => {
    expect(
      buildMetadataFilter({ purpose: 'buy', minBedrooms: 3, maxPrice: 25_000_000 }),
    ).toBe("doc.purpose = 'buy' AND doc.bedrooms >= 3 AND doc.price_pkr <= 25000000");
  });

  it('supports a closed bedroom range', () => {
    expect(buildMetadataFilter({ minBedrooms: 2, maxBedrooms: 4 })).toBe(
      'doc.bedrooms >= 2 AND doc.bedrooms <= 4',
    );
  });

  it('filters ground floor by bucket', () => {
    expect(buildMetadataFilter({ floor: 'ground' })).toBe("doc.floor = 'ground'");
  });

  it('filters an exact floor number', () => {
    expect(buildMetadataFilter({ floorNum: 3 })).toBe('doc.floor_num = 3');
  });

  it('emits verifiedOnly as a bare boolean, never a quoted string', () => {
    expect(buildMetadataFilter({ verifiedOnly: true })).toBe('doc.is_verified = true');
  });

  it('omits verifiedOnly entirely when false (false means "do not care")', () => {
    expect(buildMetadataFilter({ verifiedOnly: false })).toBe('');
  });

  // --- injection / robustness -------------------------------------------------

  it('escapes single quotes so a crafted area cannot break out of the literal', () => {
    const out = buildMetadataFilter({ area: "O'Hara' OR doc.price_pkr > 0 OR '" });
    expect(out).toContain("\\'");
    // The dangerous bare OR must not survive as syntax outside a string literal.
    expect(out).not.toMatch(/'\s+OR\s+doc\.price_pkr/);
  });

  it('drops non-finite numbers rather than emitting NaN into the filter', () => {
    expect(buildMetadataFilter({ minPrice: Number.NaN, maxPrice: Infinity })).toBe('');
  });

  it('ignores blank/whitespace-only area strings', () => {
    expect(buildMetadataFilter({ area: '   ' })).toBe('');
  });

  it('rejects a negative bedroom count', () => {
    expect(buildMetadataFilter({ minBedrooms: -2 })).toBe('');
  });

  it('coerces fractional integers so the filter stays integer-typed', () => {
    expect(buildMetadataFilter({ minBedrooms: 2.7 })).toBe('doc.bedrooms >= 2');
  });

  it('builds a full realistic query', () => {
    expect(
      buildMetadataFilter({
        purpose: 'rent',
        area: 'Clifton',
        propertyType: 'Flats',
        minBedrooms: 2,
        maxPrice: 300000,
        floor: 'ground',
      }),
    ).toBe(
      "doc.purpose = 'rent' AND (doc.area_l3_norm = 'clifton' OR doc.area_l4_norm = 'clifton' " +
        "OR doc.area_l5_norm = 'clifton') AND doc.property_type_norm = 'flats' " +
        "AND doc.bedrooms >= 2 AND doc.price_pkr <= 300000 AND doc.floor = 'ground'",
    );
  });
});
