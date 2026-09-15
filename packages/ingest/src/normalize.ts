/**
 * Turn the raw scraped hits into canonical `Listing` records, plus the facet
 * data the UI and the agent instructions both depend on.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Facets, Listing, Purpose } from '@zameen/shared';
import { normalizeHit, type RawHit } from './parse.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const DATA_DIR = join(ROOT, 'data');

function countBy<T>(items: T[], key: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function priceRange(listings: Listing[], purpose: Purpose) {
  const prices = listings.filter((l) => l.purpose === purpose && l.pricePkr > 0).map((l) => l.pricePkr);
  if (prices.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function buildFacets(listings: Listing[]): Facets {
  // Areas are counted at every level so "DHA Defence" and "DHA Phase 8" are
  // both selectable; the level is kept so the UI can indent them sensibly.
  const areaCounts = new Map<string, { level: number; count: number }>();
  for (const l of listings) {
    for (const [level, name] of [[3, l.areaL3], [4, l.areaL4], [5, l.areaL5]] as const) {
      if (!name) continue;
      const existing = areaCounts.get(name);
      if (existing) existing.count++;
      else areaCounts.set(name, { level, count: 1 });
    }
  }

  const areas = [...areaCounts.entries()]
    .map(([name, { level, count }]) => ({ name, level, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const bedroomValues = listings.map((l) => l.bedrooms).filter((b) => b > 0);

  return {
    areas,
    propertyTypes: [...countBy(listings, (l) => l.propertyType)]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    purposes: [...countBy(listings, (l) => l.purpose)]
      .map(([name, count]) => ({ name: name as Purpose, count }))
      .sort((a, b) => b.count - a.count),
    bedrooms: {
      min: bedroomValues.length ? Math.min(...bedroomValues) : 0,
      max: bedroomValues.length ? Math.max(...bedroomValues) : 0,
    },
    price: { rent: priceRange(listings, 'rent'), buy: priceRange(listings, 'buy') },
    floors: [...countBy(listings, (l) => l.floor)]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    total: listings.length,
  };
}

async function loadRaw(purpose: Purpose): Promise<RawHit[]> {
  const file = join(RAW_DIR, `${purpose}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RawHit[];
  } catch {
    throw new Error(`Missing ${file}. Run "npm run scrape" first.`);
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const listings: Listing[] = [];
  for (const purpose of ['rent', 'buy'] as const) {
    const raw = await loadRaw(purpose);
    const normalized = raw.map((hit) => normalizeHit(hit, purpose));
    // A listing with no id can't be addressed or deduplicated downstream.
    const usable = normalized.filter((l) => l.externalId !== '');
    if (usable.length !== normalized.length) {
      console.warn(`  dropped ${normalized.length - usable.length} ${purpose} listings with no id`);
    }
    listings.push(...usable);
    console.log(`${purpose}: ${usable.length} listings normalized`);
  }

  const facets = buildFacets(listings);

  await writeFile(join(DATA_DIR, 'listings.json'), JSON.stringify(listings, null, 2));
  await writeFile(join(DATA_DIR, 'facets.json'), JSON.stringify(facets, null, 2));

  const withFloor = listings.filter((l) => l.floor !== null).length;
  console.log(`\nTotal:        ${listings.length}`);
  console.log(`Areas:        ${facets.areas.length} distinct`);
  console.log(`Types:        ${facets.propertyTypes.map((t) => `${t.name} (${t.count})`).join(', ')}`);
  console.log(`Bedrooms:     ${facets.bedrooms.min}–${facets.bedrooms.max}`);
  console.log(`Floor known:  ${withFloor}/${listings.length} (${Math.round((withFloor / listings.length) * 100)}%)`);
  console.log(`\nTop 12 areas: ${facets.areas.slice(0, 12).map((a) => `${a.name} (${a.count})`).join(', ')}`);
  console.log(`\nWrote data/listings.json and data/facets.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
