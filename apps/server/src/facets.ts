import type { Facets, Purpose } from '@zameen/shared';
import { config } from './config.js';

type Meta = Record<string, unknown>;

function text(meta: Meta, key: string): string {
  const v = meta[key];
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function num(meta: Meta, key: string): number {
  const v = meta[key];
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function range(values: number[]): { min: number; max: number } {
  const usable = values.filter((v) => v > 0);
  if (usable.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...usable), max: Math.max(...usable) };
}

/**
 * Build the UI's filter facets from corpus document metadata.
 *
 * The corpus is the source of truth: the pipeline adds listings daily, so
 * deriving facets from a snapshot file on disk would leave the area list and
 * counts drifting further from reality with every run.
 */
export function aggregateFacets(documents: Meta[]): Facets {
  const areas = new Map<string, { level: number; count: number }>();
  const propertyTypes = new Map<string, number>();
  const purposes = new Map<string, number>();
  const floors = new Map<string, number>();
  const bedrooms: number[] = [];
  const rentPrices: number[] = [];
  const buyPrices: number[] = [];

  for (const meta of documents) {
    for (const [level, key] of [[3, 'area_l3'], [4, 'area_l4'], [5, 'area_l5']] as const) {
      const name = text(meta, key);
      if (!name) continue;
      const existing = areas.get(name);
      if (existing) existing.count++;
      else areas.set(name, { level, count: 1 });
    }

    const type = text(meta, 'property_type');
    if (type) propertyTypes.set(type, (propertyTypes.get(type) ?? 0) + 1);

    const purpose = text(meta, 'purpose');
    if (purpose) purposes.set(purpose, (purposes.get(purpose) ?? 0) + 1);

    // 'unknown' is the corpus sentinel for "floor not stated" — it is not a
    // floor a user would ever choose, so it never becomes a facet option.
    const floor = text(meta, 'floor');
    if (floor && floor !== 'unknown') floors.set(floor, (floors.get(floor) ?? 0) + 1);

    bedrooms.push(num(meta, 'bedrooms'));
    const price = num(meta, 'price_pkr');
    if (purpose === 'buy') buyPrices.push(price);
    else rentPrices.push(price);
  }

  const byCountThenName = <T extends { name: string; count: number }>(a: T, b: T) =>
    b.count - a.count || a.name.localeCompare(b.name);

  return {
    areas: [...areas.entries()]
      .map(([name, { level, count }]) => ({ name, level, count }))
      .sort(byCountThenName),
    propertyTypes: [...propertyTypes.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort(byCountThenName),
    purposes: [...purposes.entries()]
      .map(([name, count]) => ({ name: name as Purpose, count }))
      .sort(byCountThenName),
    floors: [...floors.entries()].map(([name, count]) => ({ name, count })).sort(byCountThenName),
    bedrooms: range(bedrooms),
    price: { rent: range(rentPrices), buy: range(buyPrices) },
    total: documents.length,
  };
}

/** Page through every document in the corpus, returning just the metadata. */
async function fetchAllMetadata(): Promise<Meta[]> {
  const headers = { 'x-api-key': config.apiKey, Accept: 'application/json' };
  const all: Meta[] = [];
  let pageKey: string | undefined;

  // Bounded so a corpus that grows unexpectedly can never hang a request.
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: '100', ...(pageKey ? { page_key: pageKey } : {}) });
    const res = await fetch(`${config.baseUrl}/corpora/${config.corpusKey}/documents?${query}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Listing corpus documents failed (HTTP ${res.status})`);

    const data = (await res.json()) as {
      documents?: { metadata?: Meta }[];
      metadata?: { page_key?: string };
    };
    for (const doc of data.documents ?? []) all.push(doc.metadata ?? {});

    pageKey = data.metadata?.page_key || undefined;
    if (!pageKey) break;
  }

  return all;
}

/**
 * Corpus-derived facets, cached.
 *
 * The pipeline changes the corpus at most once a day, so an hour-long cache
 * keeps the UI responsive without serving a stale area list for long. A failed
 * refresh keeps serving the previous value rather than breaking the page.
 */
const TTL_MS = 60 * 60 * 1000;
let cached: { at: number; facets: Facets } | null = null;
let inFlight: Promise<Facets> | null = null;

export async function getFacets(): Promise<Facets> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.facets;

  // Collapse concurrent refreshes into one pass over the corpus.
  inFlight ??= fetchAllMetadata()
    .then((docs) => {
      const facets = aggregateFacets(docs);
      cached = { at: Date.now(), facets };
      return facets;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    return await inFlight;
  } catch (err) {
    if (cached) return cached.facets;
    throw err;
  }
}
