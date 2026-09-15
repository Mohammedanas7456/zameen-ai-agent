import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWindowState, hitsFromState, normalizeHit } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '__fixtures__', 'rent-page.html'), 'utf8');

describe('extractWindowState', () => {
  it('pulls the state object out of a real listing page', () => {
    const state = extractWindowState(fixture);
    expect(state).not.toBeNull();
    expect(hitsFromState(state!)).toHaveLength(4);
  });

  it('is not fooled by a decoy brace or a </script>-like string earlier in the page', () => {
    const hits = hitsFromState(extractWindowState(fixture)!);
    // The decoy object has no externalID; real hits do.
    expect(hits.every((h) => typeof h.externalID === 'string')).toBe(true);
  });

  it('returns null when the page has no window.state (e.g. a block page)', () => {
    expect(extractWindowState('<html><body>Access denied</body></html>')).toBeNull();
  });

  it('returns null rather than throwing on truncated JSON', () => {
    expect(extractWindowState('<script>window.state = {"algolia":{"content":</script>')).toBeNull();
  });

  it('handles escaped quotes inside string values', () => {
    const html = `<script>window.state = {"a":"he said \\"hi\\" {","b":2};</script>`;
    expect(extractWindowState(html)).toEqual({ a: 'he said "hi" {', b: 2 });
  });
});

describe('normalizeHit', () => {
  const hits = hitsFromState(extractWindowState(fixture)!);
  const byId = (id: string) => hits.find((h) => h.externalID === id)!;

  it('maps the core structured fields', () => {
    const l = normalizeHit(byId('54662589'), 'rent');
    expect(l).toMatchObject({
      externalId: '54662589',
      purpose: 'rent',
      bedrooms: 2,
      bathrooms: 4,
      pricePkr: 300000,
      city: 'Karachi',
      propertyType: 'Flats',
    });
  });

  it('converts area from square metres to square feet and yards', () => {
    const l = normalizeHit(byId('54662589'), 'rent');
    // Source value is 241.5479 m² -> ~2600 sq ft -> ~289 sq yd.
    expect(l.areaSqft).toBeGreaterThan(2500);
    expect(l.areaSqft).toBeLessThan(2700);
    expect(l.areaSqyd).toBeGreaterThan(280);
    expect(l.areaSqyd).toBeLessThan(295);
    expect(Number.isInteger(l.areaSqft)).toBe(true);
  });

  it('flattens the location hierarchy into L3/L4/L5 plus a readable path', () => {
    const l = normalizeHit(byId('54662589'), 'rent');
    expect(l.areaL3).toBe('DHA Defence');
    expect(l.areaL4).toBe('DHA Phase 8');
    expect(l.areaL5).toBe('Emaar Crescent Bay');
    expect(l.areaPath).toBe('DHA Defence > DHA Phase 8 > Emaar Crescent Bay');
  });

  it('builds an absolute Zameen URL from the slug', () => {
    const l = normalizeHit(byId('54662589'), 'rent');
    expect(l.url).toMatch(/^https:\/\/www\.zameen\.com\//);
    expect(l.url).toContain('54662589');
  });

  it('parses the floor out of the listing text when stated', () => {
    expect(normalizeHit(byId('54735049'), 'rent')).toMatchObject({
      floor: 'ground',
      floorNum: 0,
    });
    expect(normalizeHit(byId('54095950'), 'rent')).toMatchObject({
      floor: 'numbered',
      floorNum: 1,
    });
  });

  it('formats a human price label in lakh/crore', () => {
    expect(normalizeHit(byId('54662589'), 'rent').priceLabel).toBe('PKR 3 Lakh');
  });

  it('never emits NaN for a listing missing numeric fields', () => {
    const broken = { ...byId('54662589'), rooms: undefined, baths: null, area: undefined, price: null };
    const l = normalizeHit(broken as never, 'rent');
    expect(Number.isNaN(l.bedrooms)).toBe(false);
    expect(Number.isNaN(l.areaSqft)).toBe(false);
    expect(Number.isNaN(l.pricePkr)).toBe(false);
  });

  it('tolerates a missing location array', () => {
    const l = normalizeHit({ ...byId('54662589'), location: undefined } as never, 'rent');
    expect(l.city).toBe('Karachi');
    expect(l.areaL3).toBe('');
  });
});

describe('cover photo', () => {
  const hits = hitsFromState(extractWindowState(fixture)!);

  it('builds a public CDN thumbnail URL from the photo id', () => {
    const l = normalizeHit(hits[0]!, 'rent');
    // The raw S3 url in the payload is a private bucket (403); the public
    // thumbnail is derived from coverPhoto.id instead.
    expect(l.coverPhoto).toMatch(/^https:\/\/media\.zameen\.com\/thumbnails\/\d+-400x300\.jpeg$/);
    expect(l.coverPhoto).not.toContain('s3');
  });

  it('is null when the listing has no photo', () => {
    expect(normalizeHit({ ...hits[0]!, coverPhoto: null }, 'rent').coverPhoto).toBeNull();
  });

  it('is null when the photo record has no id', () => {
    expect(normalizeHit({ ...hits[0]!, coverPhoto: { url: 'x' } } as never, 'rent').coverPhoto).toBeNull();
  });
});
