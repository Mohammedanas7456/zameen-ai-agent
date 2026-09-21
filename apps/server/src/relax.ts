import type { SearchFilters } from '@zameen/shared';

export interface Relaxation {
  label: string;
  filters: SearchFilters;
}

export interface ProbeResult {
  label: string;
  count: number;
}

/** Probes run per empty search. Each one is a corpus query, so this is a cost cap. */
const MAX_PROBES = 3;

/** How far to raise a budget in one step. */
const PRICE_STEP = 1.25;

function without(filters: SearchFilters, ...keys: (keyof SearchFilters)[]): SearchFilters {
  const copy: SearchFilters = { ...filters };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * Ways to loosen a search that returned nothing, so the agent's "try widening
 * X" is grounded in a count rather than a guess.
 *
 * Single-filter relaxations come first, only for filters actually set.
 * "Anywhere in Karachi" is always last and always kept when an area was
 * given: the prompt forbids the agent from switching area on its own, and a
 * count is what lets it *ask* about that with something concrete to offer.
 */
export function relaxations(filters: SearchFilters): Relaxation[] {
  const single: Relaxation[] = [];

  if (filters.floor) {
    single.push({ label: 'without the floor filter', filters: without(filters, 'floor') });
  }
  if (filters.maxPrice) {
    const raised = Math.round(filters.maxPrice * PRICE_STEP);
    single.push({
      label: `with the budget raised to PKR ${raised.toLocaleString('en-US')}`,
      filters: { ...filters, maxPrice: raised },
    });
  }
  if (filters.minBedrooms && filters.minBedrooms > 1) {
    const fewer = filters.minBedrooms - 1;
    single.push({ label: `with ${fewer}+ bedrooms`, filters: { ...filters, minBedrooms: fewer } });
  }
  if (filters.propertyType) {
    single.push({ label: 'with any property type', filters: without(filters, 'propertyType') });
  }
  // minAreaSqft, maxBedrooms and minPrice are also hard clauses in
  // buildMetadataFilter, and each can empty a search on its own — without a
  // candidate for them, a search like "rent, at least 10,000 sq ft" finds
  // nothing and has no probe to explain why.
  if (filters.minAreaSqft) {
    single.push({ label: 'without the minimum size', filters: without(filters, 'minAreaSqft') });
  }
  if (filters.maxBedrooms) {
    single.push({ label: 'without the bedroom maximum', filters: without(filters, 'maxBedrooms') });
  }
  if (filters.minPrice) {
    single.push({ label: 'without the minimum price', filters: without(filters, 'minPrice') });
  }

  const hasArea = Boolean(filters.area) || Boolean(filters.areas?.length);
  if (!hasArea) return single.slice(0, MAX_PROBES);

  return [
    ...single.slice(0, MAX_PROBES - 1),
    { label: 'anywhere in Karachi', filters: without(filters, 'area', 'areas') },
  ];
}

/**
 * Count matches for each relaxation.
 *
 * Probes run concurrently, and a failed probe is dropped rather than failing
 * the turn — this is advice attached to an answer, not the answer.
 */
export async function probeRelaxations(
  filters: SearchFilters,
  count: (filters: SearchFilters) => Promise<number>,
): Promise<ProbeResult[]> {
  const candidates = relaxations(filters);
  const counts = await Promise.all(candidates.map((c) => count(c.filters).catch(() => -1)));
  return candidates
    .map((c, i) => ({ label: c.label, count: counts[i] ?? -1 }))
    .filter((p) => p.count >= 0);
}

/**
 * Render probe counts for the agent's results message.
 *
 * `limit` is the search page size: a probe that filled the page is reported
 * as "limit+" because the true count is unknown beyond that.
 */
export function describeProbes(probes: ProbeResult[], limit: number): string {
  if (probes.length === 0) return '';
  const lines = probes.map((p) => {
    const n = p.count >= limit ? `${limit}+` : String(p.count);
    return `- ${p.label}: ${n} listing${p.count === 1 ? '' : 's'}`;
  });
  return `The system checked these relaxations (counts only; the user has not seen them):\n${lines.join('\n')}`;
}
