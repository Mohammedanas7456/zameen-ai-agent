import { describe, it, expect, vi } from 'vitest';
import type { SearchFilters } from '@zameen/shared';
import { describeProbes, probeRelaxations, relaxations } from './relax.js';

describe('relaxations', () => {
  it('returns nothing for a search with nothing to relax', () => {
    expect(relaxations({ purpose: 'rent' })).toEqual([]);
  });

  it('offers one relaxation per set filter, most conservative first', () => {
    const labels = relaxations({ purpose: 'rent', floor: 'ground', maxPrice: 100_000 }).map((r) => r.label);
    expect(labels).toEqual(['without the floor filter', 'with the budget raised to PKR 125,000']);
  });

  it('raises the budget by a quarter and keeps everything else', () => {
    expect(relaxations({ purpose: 'buy', maxPrice: 20_000_000, minBedrooms: 3 })).toContainEqual({
      label: 'with the budget raised to PKR 25,000,000',
      filters: { purpose: 'buy', maxPrice: 25_000_000, minBedrooms: 3 },
    });
  });

  it('never relaxes purpose', () => {
    for (const r of relaxations({ purpose: 'buy', maxPrice: 1, floor: 'top', minBedrooms: 2 })) {
      expect(r.filters.purpose).toBe('buy');
    }
  });

  it('goes down one bedroom but never below one', () => {
    expect(relaxations({ purpose: 'rent', minBedrooms: 3 })).toEqual([
      { label: 'with 2+ bedrooms', filters: { purpose: 'rent', minBedrooms: 2 } },
    ]);
    expect(relaxations({ purpose: 'rent', minBedrooms: 1 })).toEqual([]);
  });

  it('drops the area last and always keeps that probe when an area was set', () => {
    const rs = relaxations({
      purpose: 'rent',
      area: 'Clifton',
      floor: 'ground',
      maxPrice: 100_000,
      minBedrooms: 3,
      propertyType: 'Flats',
    });
    expect(rs).toHaveLength(3);
    expect(rs[2]).toEqual({
      label: 'anywhere in Karachi',
      filters: { purpose: 'rent', floor: 'ground', maxPrice: 100_000, minBedrooms: 3, propertyType: 'Flats' },
    });
  });

  it('drops several areas together', () => {
    expect(relaxations({ purpose: 'rent', areas: ['Gulshan-e-Iqbal', 'Gulistan-e-Jauhar'] })).toEqual([
      { label: 'anywhere in Karachi', filters: { purpose: 'rent' } },
    ]);
  });

  it('caps the number of probes', () => {
    expect(
      relaxations({ purpose: 'rent', floor: 'top', maxPrice: 5, minBedrooms: 4, propertyType: 'Houses' }),
    ).toHaveLength(3);
  });
});

describe('probeRelaxations', () => {
  it('counts each candidate and drops the ones whose query failed', async () => {
    const count = vi.fn(async (f: SearchFilters) => {
      if (f.floor === undefined) throw new Error('boom');
      return 7;
    });
    const probes = await probeRelaxations({ purpose: 'rent', floor: 'ground', maxPrice: 100_000 }, count);
    expect(count).toHaveBeenCalledTimes(2);
    expect(probes).toEqual([{ label: 'with the budget raised to PKR 125,000', count: 7 }]);
  });

  it('is empty when there is nothing to relax, without calling the counter', async () => {
    const count = vi.fn(async () => 1);
    expect(await probeRelaxations({ purpose: 'rent' }, count)).toEqual([]);
    expect(count).not.toHaveBeenCalled();
  });
});

describe('describeProbes', () => {
  it('is empty with no probes', () => {
    expect(describeProbes([], 40)).toBe('');
  });

  it('lists counts, saying "40+" when a probe filled the page', () => {
    expect(
      describeProbes(
        [
          { label: 'anywhere in Karachi', count: 40 },
          { label: 'with 2+ bedrooms', count: 1 },
          { label: 'without the floor filter', count: 0 },
        ],
        40,
      ),
    ).toBe(
      'The system checked these relaxations (counts only; the user has not seen them):\n' +
        '- anywhere in Karachi: 40+ listings\n' +
        '- with 2+ bedrooms: 1 listing\n' +
        '- without the floor filter: 0 listings',
    );
  });
});
