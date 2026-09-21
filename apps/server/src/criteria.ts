import type { FloorBucket, Listing, SearchFilters } from '@zameen/shared';

/** The flat arguments the agent passes to the `search_properties` lambda. */
export interface AgentCriteria {
  purpose?: unknown;
  area?: unknown;
  min_bedrooms?: unknown;
  max_bedrooms?: unknown;
  min_price?: unknown;
  max_price?: unknown;
  property_type?: unknown;
  floor?: unknown;
  min_area_sqft?: unknown;
  /** The user's own words for ranking, e.g. "sea facing". Never a filter. */
  query?: unknown;
}

const FLOORS: FloorBucket[] = ['ground', 'lower', 'upper', 'top', 'numbered'];

/** The lambda receives ints but JSON round-trips them as floats (3 -> 3.0). */
function positiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The agent packs several areas into one string, e.g. "Gulshan, Johar" or
 *  "Gulshan and Johar" — split on the delimiters it's told to use. */
const AREA_SPLIT = /\s*(?:,|&|\band\b)\s*/i;

function areaNames(value: unknown): string[] {
  // The lambda returns one area as a string and several as a list; the raw
  // tool input is always the one comma-separated string it was told to send.
  const raw = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').join(',')
    : text(value);
  if (!raw) return [];
  return raw
    .split(AREA_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Convert the agent's tool arguments into our `SearchFilters`.
 *
 * This is the seam where the model's output stops being trusted: everything is
 * re-validated here, then passed through the same `buildMetadataFilter` the
 * sidebar uses, so both paths enforce constraints identically.
 *
 * Zero is the lambda's "not set" sentinel for every numeric field, which is why
 * only strictly positive values become filters.
 */
export function criteriaToFilters(criteria: AgentCriteria): SearchFilters {
  const filters: SearchFilters = {};

  const purpose = text(criteria.purpose)?.toLowerCase();
  if (purpose === 'rent' || purpose === 'buy') filters.purpose = purpose;

  const areas = areaNames(criteria.area);
  if (areas.length === 1) filters.area = areas[0];
  else if (areas.length > 1) filters.areas = areas;

  const propertyType = text(criteria.property_type);
  if (propertyType) filters.propertyType = propertyType;

  const minBedrooms = positiveInt(criteria.min_bedrooms);
  if (minBedrooms !== undefined) filters.minBedrooms = minBedrooms;

  const maxBedrooms = positiveInt(criteria.max_bedrooms);
  if (maxBedrooms !== undefined) filters.maxBedrooms = maxBedrooms;

  const minPrice = positiveInt(criteria.min_price);
  if (minPrice !== undefined) filters.minPrice = minPrice;

  const maxPrice = positiveInt(criteria.max_price);
  if (maxPrice !== undefined) filters.maxPrice = maxPrice;

  const minAreaSqft = positiveInt(criteria.min_area_sqft);
  if (minAreaSqft !== undefined) filters.minAreaSqft = minAreaSqft;

  const floor = text(criteria.floor)?.toLowerCase() as FloorBucket | undefined;
  if (floor && FLOORS.includes(floor)) filters.floor = floor;

  // An inverted range would match nothing; drop the weaker bound instead of
  // silently returning an empty result set.
  if (
    filters.minBedrooms !== undefined &&
    filters.maxBedrooms !== undefined &&
    filters.minBedrooms > filters.maxBedrooms
  ) {
    delete filters.maxBedrooms;
  }
  if (
    filters.minPrice !== undefined &&
    filters.maxPrice !== undefined &&
    filters.minPrice > filters.maxPrice
  ) {
    delete filters.minPrice;
  }

  return filters;
}

/** Longest ranking query passed to the corpus. */
const MAX_QUERY_CHARS = 300;

/**
 * The user's own words for ranking, if the agent passed any.
 *
 * This is the one model-supplied value that reaches the corpus as free text
 * rather than as a validated filter, so it is bounded: a runaway argument
 * must not become a runaway query.
 */
export function semanticQuery(criteria: AgentCriteria): string | undefined {
  const raw = text(criteria.query);
  if (!raw) return undefined;
  return raw.replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS);
}

/** A plain-language echo of what was searched, for the activity chip. */
export function describeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  if (filters.purpose) parts.push(filters.purpose === 'rent' ? 'for rent' : 'for sale');
  if (filters.areas?.length) parts.push(`in ${filters.areas.join(' or ')}`);
  else if (filters.area) parts.push(`in ${filters.area}`);
  if (filters.propertyType) parts.push(filters.propertyType.toLowerCase());
  if (filters.minBedrooms) parts.push(`${filters.minBedrooms}+ beds`);
  if (filters.maxPrice) parts.push(`under PKR ${filters.maxPrice.toLocaleString('en-US')}`);
  if (filters.floor) parts.push(`${filters.floor} floor`);
  return parts.join(', ') || 'all listings';
}

const FLOOR_PHRASE: Record<string, string> = {
  ground: 'ground floor',
  lower: 'lower portion',
  upper: 'upper portion',
  top: 'top floor',
};

/** A floor phrase fit to hand to the agent — never the raw bucket name. */
function floorPhrase(listing: Pick<Listing, 'floor' | 'floorNum'>): string | null {
  if (listing.floor === 'numbered') {
    if (listing.floorNum === null) return null;
    return listing.floorNum === 0 ? 'ground floor' : `floor ${listing.floorNum}`;
  }
  return listing.floor ? (FLOOR_PHRASE[listing.floor] ?? null) : null;
}

/**
 * Render listings as compact text for the agent's follow-up turn.
 *
 * The agent never sees raw search output, so this is the only description of
 * the results it gets — it must be complete enough to talk about and short
 * enough not to dominate the context.
 */
export function listingsForAgent(listings: Listing[], max = 8): string {
  if (listings.length === 0) return 'No listings matched those criteria.';

  const lines = listings.slice(0, max).map((l, i) => {
    const bits = [
      `${l.bedrooms} bed`,
      `${l.bathrooms} bath`,
      `${l.areaSqft.toLocaleString('en-US')} sq ft`,
      l.propertyType,
      floorPhrase(l),
      l.isVerified ? 'verified' : null,
    ].filter(Boolean);
    return `${i + 1}. ${l.priceLabel} — ${bits.join(', ')} — ${l.areaPath}\n   "${l.title}"`;
  });

  const more =
    listings.length > max ? `\n(${listings.length - max} further matches are shown to the user.)` : '';
  return `${listings.length} listings matched. Top ${Math.min(max, listings.length)}:\n\n${lines.join('\n')}${more}`;
}
