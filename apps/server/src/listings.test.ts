import { describe, it, expect } from 'vitest';
import { extractListings, listingFromMetadata } from './listings.js';

const meta = {
  external_id: '54662589',
  title: 'CHANCE DEAL 2 BEDROOM APARTMENT',
  url: 'https://www.zameen.com/Property/x-54662589-10721-4.html',
  purpose: 'rent',
  property_type: 'Flats',
  bedrooms: 2,
  bathrooms: 4,
  price_pkr: 300000,
  price_label: 'PKR 3 Lakh',
  area_sqft: 2600,
  area_sqyd: 289,
  city: 'Karachi',
  area_l3: 'DHA Defence',
  area_l4: 'DHA Phase 8',
  area_l5: 'Emaar Crescent Bay',
  area_path: 'DHA Defence > DHA Phase 8 > Emaar Crescent Bay',
  floor: 'unknown',
  floor_num: -1,
  is_verified: false,
  photo_count: 25,
  cover_photo: '',
  agency: '',
};

describe('listingFromMetadata', () => {
  it('maps metadata onto a Listing', () => {
    expect(listingFromMetadata(meta)).toMatchObject({
      externalId: '54662589',
      purpose: 'rent',
      bedrooms: 2,
      pricePkr: 300000,
      areaPath: 'DHA Defence > DHA Phase 8 > Emaar Crescent Bay',
    });
  });

  it('turns the "unknown" floor sentinel back into null', () => {
    const l = listingFromMetadata(meta)!;
    expect(l.floor).toBeNull();
    expect(l.floorNum).toBeNull();
  });

  it('keeps a real floor', () => {
    const l = listingFromMetadata({ ...meta, floor: 'ground', floor_num: 0 })!;
    expect(l.floor).toBe('ground');
    expect(l.floorNum).toBe(0);
  });

  it('coerces string-typed numbers', () => {
    const l = listingFromMetadata({ ...meta, bedrooms: '3', price_pkr: '450000' })!;
    expect(l.bedrooms).toBe(3);
    expect(l.pricePkr).toBe(450000);
  });

  it('treats the string "true" as verified', () => {
    expect(listingFromMetadata({ ...meta, is_verified: 'true' })!.isVerified).toBe(true);
  });

  it('returns null without an external_id, rather than a blank card', () => {
    const { external_id, ...rest } = meta;
    expect(listingFromMetadata(rest)).toBeNull();
  });

  it('normalises empty strings to null for optional fields', () => {
    const l = listingFromMetadata(meta)!;
    expect(l.coverPhoto).toBeNull();
    expect(l.agency).toBeNull();
  });
});

describe('extractListings', () => {
  it('finds listings in a query-API response shape', () => {
    const payload = { search_results: [{ score: 1, document_metadata: meta, text: '...' }] };
    expect(extractListings(payload)).toHaveLength(1);
  });

  it('finds listings nested inside an agent tool_output', () => {
    const payload = {
      tool_output: { results: { documents: [{ metadata: meta, artifact_id: 'a1' }] } },
    };
    expect(extractListings(payload)[0]?.externalId).toBe('54662589');
  });

  it('finds bare metadata objects', () => {
    expect(extractListings([meta])).toHaveLength(1);
  });

  it('de-duplicates the same listing matched on several parts', () => {
    const payload = {
      search_results: [
        { document_metadata: meta },
        { document_metadata: meta },
        { document_metadata: { ...meta, external_id: '999' } },
      ],
    };
    expect(extractListings(payload)).toHaveLength(2);
  });

  it('preserves ranking order', () => {
    const payload = {
      search_results: [
        { document_metadata: { ...meta, external_id: 'b' } },
        { document_metadata: { ...meta, external_id: 'a' } },
      ],
    };
    expect(extractListings(payload).map((l) => l.externalId)).toEqual(['b', 'a']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      document_metadata: { ...meta, external_id: `id-${i}` },
    }));
    expect(extractListings({ search_results: many }, 4)).toHaveLength(4);
  });

  it('returns an empty array for unrelated payloads', () => {
    expect(extractListings({ hello: 'world' })).toEqual([]);
    expect(extractListings(null)).toEqual([]);
    expect(extractListings('a string')).toEqual([]);
  });

  it('does not hang on a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { document_metadata: meta };
    cyclic['self'] = cyclic;
    expect(extractListings(cyclic)).toHaveLength(1);
  });
});
