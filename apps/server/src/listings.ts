import type { Listing, Purpose } from '@zameen/shared';

/** Vectara returns metadata values as strings/numbers/booleans, untyped. */
type Meta = Record<string, unknown>;

function str(meta: Meta, key: string, fallback = ''): string {
  const v = meta[key];
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function int(meta: Meta, key: string, fallback = 0): number {
  const v = meta[key];
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function bool(meta: Meta, key: string): boolean {
  const v = meta[key];
  return v === true || v === 'true';
}

/**
 * Rebuild a `Listing` from the document metadata Vectara echoes back.
 *
 * The corpus is the single source of truth for what the agent saw, so the UI
 * renders from search results rather than from the local snapshot — the two
 * can't drift out of sync that way.
 */
export function listingFromMetadata(meta: Meta): Listing | null {
  const externalId = str(meta, 'external_id');
  if (!externalId) return null;

  const purpose: Purpose = str(meta, 'purpose') === 'buy' ? 'buy' : 'rent';
  const floorRaw = str(meta, 'floor', 'unknown');
  const floorNum = int(meta, 'floor_num', -1);

  return {
    externalId,
    title: str(meta, 'title'),
    description: '',
    url: str(meta, 'url', 'https://www.zameen.com'),
    purpose,
    propertyType: str(meta, 'property_type', 'Property'),
    bedrooms: int(meta, 'bedrooms'),
    bathrooms: int(meta, 'bathrooms'),
    pricePkr: int(meta, 'price_pkr'),
    priceLabel: str(meta, 'price_label'),
    rentFrequency: null,
    areaSqft: int(meta, 'area_sqft'),
    areaSqyd: int(meta, 'area_sqyd'),
    city: str(meta, 'city', 'Karachi'),
    areaL3: str(meta, 'area_l3'),
    areaL4: str(meta, 'area_l4'),
    areaL5: str(meta, 'area_l5'),
    areaPath: str(meta, 'area_path'),
    locationSlug: '',
    // 'unknown' is the corpus sentinel for "not stated" — surface it as null
    // so the UI never claims a floor we don't actually know.
    floor: floorRaw === 'unknown' ? null : (floorRaw as Listing['floor']),
    floorNum: floorNum < 0 ? null : floorNum,
    floorRaw: null,
    lat: int(meta, 'lat') || null,
    lng: int(meta, 'lng') || null,
    isVerified: bool(meta, 'is_verified'),
    agency: str(meta, 'agency') || null,
    photoCount: int(meta, 'photo_count'),
    coverPhoto: str(meta, 'cover_photo') || null,
    listedAt: int(meta, 'listed_at'),
    sourceUrl: str(meta, 'source_url'),
    firstSeenAt: int(meta, 'first_seen_at'),
    lastSeenAt: int(meta, 'last_seen_at'),
  };
}

/**
 * Pull listings out of anything Vectara hands back — a query response, or a
 * tool_output event from the agent.
 *
 * The two endpoints nest results differently (and the agent's tool wraps them
 * again), so rather than hard-coding one path this walks the structure looking
 * for objects carrying our metadata signature. De-duplicated by listing id,
 * first occurrence wins, so ranking order is preserved.
 */
export function extractListings(payload: unknown, limit = 60): Listing[] {
  const found = new Map<string, Listing>();
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (found.size >= limit || depth > 8 || node === null || typeof node !== 'object') return;
    // Guard against cycles in the returned structure.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    const obj = node as Meta;

    // A document's metadata can arrive under either key depending on endpoint.
    for (const key of ['document_metadata', 'metadata']) {
      const meta = obj[key];
      if (meta && typeof meta === 'object' && 'external_id' in (meta as Meta)) {
        const listing = listingFromMetadata(meta as Meta);
        if (listing && !found.has(listing.externalId)) found.set(listing.externalId, listing);
      }
    }

    // Or the object may itself be the metadata.
    if ('external_id' in obj && 'price_pkr' in obj) {
      const listing = listingFromMetadata(obj);
      if (listing && !found.has(listing.externalId)) found.set(listing.externalId, listing);
    }

    for (const value of Object.values(obj)) walk(value, depth + 1);
  };

  walk(payload, 0);
  return [...found.values()].slice(0, limit);
}
